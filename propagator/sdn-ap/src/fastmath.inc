// -----------------------------------------------------------------------------
// sincos: the sine and cosine of one argument from one range reduction
// (Cody-Waite in three parts of pi/2) and the minimax kernels of FDLIBM
// (k_sin.c, k_cos.c; error below one unit in the last place). Arguments
// beyond 2^20 pi/2 fall back to the library functions.
//
// The kernel coefficients (k_sin.c, k_cos.c) and the pi/2 constants
// (e_rem_pio2.c) are FDLIBM's, as FreeBSD msun and musl carry them, under the
// notice those files carry (this package's LICENSES/Sun-FDLIBM.txt):
//
// ====================================================
// Copyright (C) 1993 by Sun Microsystems, Inc. All rights reserved.
//
// Developed at SunSoft, a Sun Microsystems, Inc. business.
// Permission to use, copy, modify, and distribute this
// software is freely granted, provided that this notice
// is preserved.
// ====================================================
// -----------------------------------------------------------------------------

#ifdef __wasm_simd128__
#include <wasm_simd128.h>
#endif

namespace sdnap {
namespace fm {

constexpr double kInvPio2 = 6.36619772367581382433e-01;
constexpr double kPio2_1 = 1.57079632673412561417e+00;
constexpr double kPio2_1t = 6.07710050650619224932e-11;
constexpr double kPio2_2 = 6.07710050630396597660e-11;
constexpr double kPio2_2t = 2.02226624879595063154e-21;
constexpr double kPio2_3 = 2.02226624871116645580e-21;
constexpr double kPio2_3t = 8.47842766036889956997e-32;
constexpr double kToInt = 6755399441055744.0;  // 1.5 / DBL_EPSILON: round to nearest

constexpr inline int exponent_bits(double x) {
  return static_cast<int>((__builtin_bit_cast(uint64_t, x) >> 52) & 0x7ff);
}

constexpr inline double ksin(double x, double y, bool tail) {
  constexpr double S1 = -1.66666666666666324348e-01, S2 = 8.33333333332248946124e-03,
                   S3 = -1.98412698298579493134e-04, S4 = 2.75573137070700676789e-06,
                   S5 = -2.50507602534068634195e-08, S6 = 1.58969099521155010221e-10;
  const double z = x * x, w = z * z;
  const double r = S2 + z * (S3 + z * S4) + z * w * (S5 + z * S6);
  const double v = z * x;
  if (!tail) return x + v * (S1 + z * r);
  return x - ((z * (0.5 * y - v * r) - y) - v * S1);
}

constexpr inline double kcos(double x, double y) {
  constexpr double C1 = 4.16666666666666019037e-02, C2 = -1.38888888888741095749e-03,
                   C3 = 2.48015872894767294178e-05, C4 = -2.75573143513906633035e-07,
                   C5 = 2.08757232129817482790e-09, C6 = -1.13596475577881948265e-11;
  const double z = x * x, w = z * z;
  const double r = z * (C1 + z * (C2 + z * C3)) + w * w * (C4 + z * (C5 + z * C6));
  const double hz = 0.5 * z;
  const double ww = 1.0 - hz;
  return ww + (((1.0 - ww) - hz) + (z * r - x * y));
}

constexpr inline void sincos(double x, double& s, double& c) {
  const double ax = __builtin_fabs(x);
  if (ax <= 0.7853981633974483) {  // |x| <= pi/4
    s = ksin(x, 0.0, false);
    c = kcos(x, 0.0);
    return;
  }
  if (!(ax < 1647099.3291652855)) {  // 2^20 pi/2, or not finite
    s = std::sin(x);
    c = std::cos(x);
    return;
  }
  const double fn = (x * kInvPio2 + kToInt) - kToInt;
  double r = x - fn * kPio2_1;
  double w = fn * kPio2_1t;
  double y = r - w;
  const int ex = exponent_bits(x);
  if (ex - exponent_bits(y) > 16) {
    double t = r;
    w = fn * kPio2_2;
    r = t - w;
    w = fn * kPio2_2t - ((t - r) - w);
    y = r - w;
    if (ex - exponent_bits(y) > 49) {
      t = r;
      w = fn * kPio2_3;
      r = t - w;
      w = fn * kPio2_3t - ((t - r) - w);
      y = r - w;
    }
  }
  const double y1 = (r - y) - w;
  const double sk = ksin(y, y1, true), ck = kcos(y, y1);
  switch (static_cast<int>(fn) & 3) {
    case 0: s = sk; c = ck; break;
    case 1: s = ck; c = -sk; break;
    case 2: s = -sk; c = -ck; break;
    default: s = -ck; c = sk; break;
  }
}

inline double exp(double x) {
  if (x <= -708.3964185322641) return 0.0;
  if (!(x < 709.0)) return std::exp(x);
  constexpr double kInvLn2 = 1.44269504088896340736;
  constexpr double kLn2Hi = 6.93147180369123816490e-01;
  constexpr double kLn2Lo = 1.90821492927058770002e-10;
  const double fn = (x * kInvLn2 + kToInt) - kToInt;
  const double r = (x - fn * kLn2Hi) - fn * kLn2Lo;
  const double p =
      1.0 + r * (1.0 + r * (0.5 + r * (1.66666666666666657415e-01 +
      r * (4.16666666666666643537e-02 + r * (8.33333333333333321769e-03 +
      r * (1.38888888888888894085e-03 + r * (1.98412698412698412698e-04 +
      r * (2.48015873015873015873e-05 + r * (2.75573192239858925175e-06 +
      r * (2.75573192239858906526e-07 + r * 2.50521083854417187751e-08))))))))));
  const uint64_t scale_bits = static_cast<uint64_t>(static_cast<int64_t>(fn) + 1023) << 52;
  double scale = 1.0;
  std::memcpy(&scale, &scale_bits, 8);
  return p * scale;
}

inline double log(double x) {
  uint64_t u;
  std::memcpy(&u, &x, 8);
  const uint64_t exp_raw = (u >> 52) & 0x7ffULL;
  if (!(x > 0.0) || exp_raw == 0ULL || exp_raw == 0x7ffULL) return std::log(x);
  constexpr double kLn2Hi = 6.93147180369123816490e-01;
  constexpr double kLn2Lo = 1.90821492927058770002e-10;
  constexpr double Lg1 = 6.666666666666735130e-01, Lg2 = 3.999999999940941908e-01,
                   Lg3 = 2.857142874366239149e-01, Lg4 = 2.222219843214978396e-01,
                   Lg5 = 1.818357216161805012e-01, Lg6 = 1.531383769920937332e-01,
                   Lg7 = 1.479819860511658591e-01;
  const uint64_t u_adj = u + 0x00095f619980c433ULL;
  const double dk = static_cast<double>(static_cast<int64_t>(u_adj >> 52) - 1023);
  const uint64_t m_bits = (u_adj & 0x000fffffffffffffULL) + 0x3fe6a09e667f3bcdULL;
  double m;
  std::memcpy(&m, &m_bits, 8);
  const double f = m - 1.0;
  const double s = f / (2.0 + f);
  const double z = s * s, w = z * z;
  const double t1 = w * (Lg2 + w * (Lg4 + w * Lg6));
  const double t2 = z * (Lg1 + w * (Lg3 + w * (Lg5 + w * Lg7)));
  const double hfsq = 0.5 * f * f;
  return dk * kLn2Hi - ((hfsq - (s * (hfsq + (t2 + t1)) + dk * kLn2Lo)) - f);
}

[[gnu::always_inline]] inline void sincos_fast(double x, double& s, double& c) {
  if (__builtin_expect(!(__builtin_fabs(x) < 1647099.3291652855), 0)) {
    sincos(x, s, c);
    return;
  }
  const double bias = x * kInvPio2 + kToInt;
  const double fn = bias - kToInt;
  const double t = x - fn * kPio2_1;
  const double w2 = fn * kPio2_2;
  const double r = t - w2;
  const double w = fn * kPio2_2t - ((t - r) - w2);
  const double y = r - w;
  const double y1 = (r - y) - w;
  const double sk = ksin(y, y1, true), ck = kcos(y, y1);
  const uint64_t ub = __builtin_bit_cast(uint64_t, bias);
  const uint64_t b0_sign = ub << 63;
  const uint64_t s_sign = (ub << 62) & 0x8000000000000000ULL;
  const uint64_t c_sign = s_sign ^ b0_sign;
  const double s_mag = (ub & 1ULL) ? ck : sk;
  const double c_mag = (ub & 1ULL) ? sk : ck;
  s = __builtin_bit_cast(double, __builtin_bit_cast(uint64_t, s_mag) ^ s_sign);
  c = __builtin_bit_cast(double, __builtin_bit_cast(uint64_t, c_mag) ^ c_sign);
}

#ifdef __wasm_simd128__
[[gnu::always_inline]] inline void sincos2_f64x2(v128_t vx, v128_t& vs, v128_t& vc) {
  const v128_t v_abs = wasm_f64x2_abs(vx);
  if (__builtin_expect(!wasm_i64x2_all_true(wasm_f64x2_lt(v_abs, wasm_f64x2_splat(1647099.3291652855))), 0)) {
    double s0, c0, s1, c1;
    sincos(wasm_f64x2_extract_lane(vx, 0), s0, c0);
    sincos(wasm_f64x2_extract_lane(vx, 1), s1, c1);
    vs = wasm_f64x2_make(s0, s1);
    vc = wasm_f64x2_make(c0, c1);
    return;
  }
  const v128_t v_to_int = wasm_f64x2_splat(kToInt);
  const v128_t v_bias = wasm_f64x2_add(wasm_f64x2_mul(vx, wasm_f64x2_splat(kInvPio2)), v_to_int);
  const v128_t v_fn = wasm_f64x2_sub(v_bias, v_to_int);
  const v128_t vt = wasm_f64x2_sub(vx, wasm_f64x2_mul(v_fn, wasm_f64x2_splat(kPio2_1)));
  const v128_t vw2 = wasm_f64x2_mul(v_fn, wasm_f64x2_splat(kPio2_2));
  const v128_t vr = wasm_f64x2_sub(vt, vw2);
  const v128_t vw = wasm_f64x2_sub(wasm_f64x2_mul(v_fn, wasm_f64x2_splat(kPio2_2t)),
                                   wasm_f64x2_sub(wasm_f64x2_sub(vt, vr), vw2));
  const v128_t vy = wasm_f64x2_sub(vr, vw);
  const v128_t vy1 = wasm_f64x2_sub(wasm_f64x2_sub(vr, vy), vw);

  const v128_t vz = wasm_f64x2_mul(vy, vy);
  const v128_t vw4 = wasm_f64x2_mul(vz, vz);
  const v128_t vrs = wasm_f64x2_add(
      wasm_f64x2_add(wasm_f64x2_splat(8.33333333332248946124e-03),
                     wasm_f64x2_mul(vz, wasm_f64x2_add(wasm_f64x2_splat(-1.98412698298579493134e-04),
                                                       wasm_f64x2_mul(vz, wasm_f64x2_splat(2.75573137070700676789e-06))))),
      wasm_f64x2_mul(wasm_f64x2_mul(vz, vw4),
                     wasm_f64x2_add(wasm_f64x2_splat(-2.50507602534068634195e-08),
                                    wasm_f64x2_mul(vz, wasm_f64x2_splat(1.58969099521155010221e-10)))));
  const v128_t vv = wasm_f64x2_mul(vz, vy);
  const v128_t v_half = wasm_f64x2_splat(0.5);
  const v128_t vsk = wasm_f64x2_sub(
      vy, wasm_f64x2_sub(wasm_f64x2_sub(wasm_f64x2_mul(vz, wasm_f64x2_sub(wasm_f64x2_mul(v_half, vy1), wasm_f64x2_mul(vv, vrs))),
                                        vy1),
                         wasm_f64x2_mul(vv, wasm_f64x2_splat(-1.66666666666666324348e-01))));

  const v128_t vrc = wasm_f64x2_add(
      wasm_f64x2_mul(vz, wasm_f64x2_add(wasm_f64x2_splat(4.16666666666666019037e-02),
                                        wasm_f64x2_mul(vz, wasm_f64x2_add(wasm_f64x2_splat(-1.38888888888741095749e-03),
                                                                          wasm_f64x2_mul(vz, wasm_f64x2_splat(2.48015872894767294178e-05)))))),
      wasm_f64x2_mul(wasm_f64x2_mul(vw4, vw4),
                     wasm_f64x2_add(wasm_f64x2_splat(-2.75573143513906633035e-07),
                                    wasm_f64x2_mul(vz, wasm_f64x2_add(wasm_f64x2_splat(2.08757232129817482790e-09),
                                                                      wasm_f64x2_mul(vz, wasm_f64x2_splat(-1.13596475577881948265e-11)))))));
  const v128_t v_one = wasm_f64x2_splat(1.0);
  const v128_t vhz = wasm_f64x2_mul(v_half, vz);
  const v128_t vww = wasm_f64x2_sub(v_one, vhz);
  const v128_t vck = wasm_f64x2_add(
      vww, wasm_f64x2_add(wasm_f64x2_sub(wasm_f64x2_sub(v_one, vww), vhz),
                          wasm_f64x2_sub(wasm_f64x2_mul(vz, vrc), wasm_f64x2_mul(vy, vy1))));

  const v128_t v_b0_sign = wasm_i64x2_shl(v_bias, 63);
  const v128_t v_swap = wasm_i64x2_shr(v_b0_sign, 63);
  const v128_t v_s_sign = wasm_v128_and(wasm_i64x2_shl(v_bias, 62), wasm_i64x2_splat(static_cast<int64_t>(0x8000000000000000ULL)));
  const v128_t v_c_sign = wasm_v128_xor(v_s_sign, v_b0_sign);
  vs = wasm_v128_xor(wasm_v128_bitselect(vck, vsk, v_swap), v_s_sign);
  vc = wasm_v128_xor(wasm_v128_bitselect(vsk, vck, v_swap), v_c_sign);
}

[[gnu::always_inline]] inline void sincos2_f64x2(double x0, double x1, double& s0, double& c0, double& s1, double& c1) {
  v128_t vs, vc;
  sincos2_f64x2(wasm_f64x2_make(x0, x1), vs, vc);
  s0 = wasm_f64x2_extract_lane(vs, 0);
  s1 = wasm_f64x2_extract_lane(vs, 1);
  c0 = wasm_f64x2_extract_lane(vc, 0);
  c1 = wasm_f64x2_extract_lane(vc, 1);
}

[[gnu::always_inline]] inline v128_t exp2_f64x2(v128_t vx) {
  const v128_t v_min = wasm_f64x2_splat(-708.3964185322641);
  const v128_t v_max = wasm_f64x2_splat(709.0);
  if (__builtin_expect(!wasm_i64x2_all_true(wasm_f64x2_lt(vx, v_max)), 0)) {
    return wasm_f64x2_make(exp(wasm_f64x2_extract_lane(vx, 0)), exp(wasm_f64x2_extract_lane(vx, 1)));
  }
  const v128_t v_gt_min = wasm_f64x2_gt(vx, v_min);
  const v128_t vx_c = wasm_f64x2_max(vx, v_min);
  const v128_t v_to_int = wasm_f64x2_splat(kToInt);
  const v128_t v_bias = wasm_f64x2_add(wasm_f64x2_mul(vx_c, wasm_f64x2_splat(1.44269504088896340736)), v_to_int);
  const v128_t v_fn = wasm_f64x2_sub(v_bias, v_to_int);
  const v128_t vr = wasm_f64x2_sub(wasm_f64x2_sub(vx_c, wasm_f64x2_mul(v_fn, wasm_f64x2_splat(6.93147180369123816490e-01))),
                                   wasm_f64x2_mul(v_fn, wasm_f64x2_splat(1.90821492927058770002e-10)));
  v128_t vp = wasm_f64x2_add(wasm_f64x2_splat(2.75573192239858906526e-07),
                             wasm_f64x2_mul(vr, wasm_f64x2_splat(2.50521083854417187751e-08)));
  vp = wasm_f64x2_add(wasm_f64x2_splat(2.75573192239858925175e-06), wasm_f64x2_mul(vr, vp));
  vp = wasm_f64x2_add(wasm_f64x2_splat(2.48015873015873015873e-05), wasm_f64x2_mul(vr, vp));
  vp = wasm_f64x2_add(wasm_f64x2_splat(1.98412698412698412698e-04), wasm_f64x2_mul(vr, vp));
  vp = wasm_f64x2_add(wasm_f64x2_splat(1.38888888888888894085e-03), wasm_f64x2_mul(vr, vp));
  vp = wasm_f64x2_add(wasm_f64x2_splat(8.33333333333333321769e-03), wasm_f64x2_mul(vr, vp));
  vp = wasm_f64x2_add(wasm_f64x2_splat(4.16666666666666643537e-02), wasm_f64x2_mul(vr, vp));
  vp = wasm_f64x2_add(wasm_f64x2_splat(1.66666666666666657415e-01), wasm_f64x2_mul(vr, vp));
  vp = wasm_f64x2_add(wasm_f64x2_splat(0.5), wasm_f64x2_mul(vr, vp));
  vp = wasm_f64x2_add(wasm_f64x2_splat(1.0), wasm_f64x2_mul(vr, vp));
  vp = wasm_f64x2_add(wasm_f64x2_splat(1.0), wasm_f64x2_mul(vr, vp));
  const v128_t v_scale = wasm_i64x2_shl(wasm_i64x2_add(v_bias, wasm_i64x2_splat(1023)), 52);
  return wasm_v128_and(wasm_f64x2_mul(vp, v_scale), v_gt_min);
}

[[gnu::always_inline]] inline v128_t log2_f64x2(v128_t vx) {
  const v128_t v_min_norm = wasm_i64x2_splat(0x0010000000000000LL);
  const v128_t v_max_norm = wasm_i64x2_splat(0x7ff0000000000000LL);
  if (__builtin_expect(!wasm_i64x2_all_true(wasm_v128_and(wasm_f64x2_ge(vx, v_min_norm), wasm_f64x2_lt(vx, v_max_norm))), 0)) {
    return wasm_f64x2_make(log(wasm_f64x2_extract_lane(vx, 0)), log(wasm_f64x2_extract_lane(vx, 1)));
  }
  const v128_t vu_adj = wasm_i64x2_add(vx, wasm_i64x2_splat(0x00095f619980c433LL));
  const v128_t vdk = wasm_f64x2_sub(
      wasm_v128_or(wasm_u64x2_shr(vu_adj, 52), wasm_i64x2_splat(0x4338000000000000LL)),
      wasm_f64x2_splat(6755399441056767.0));
  const v128_t vm = wasm_i64x2_add(wasm_v128_and(vu_adj, wasm_i64x2_splat(0x000fffffffffffffLL)),
                                   wasm_i64x2_splat(0x3fe6a09e667f3bcdLL));
  const v128_t vf = wasm_f64x2_sub(vm, wasm_f64x2_splat(1.0));
  const v128_t vs = wasm_f64x2_div(vf, wasm_f64x2_add(wasm_f64x2_splat(2.0), vf));
  const v128_t vz = wasm_f64x2_mul(vs, vs), vw = wasm_f64x2_mul(vz, vz);
  const v128_t vt1 = wasm_f64x2_mul(
      vw, wasm_f64x2_add(wasm_f64x2_splat(3.999999999940941908e-01),
                         wasm_f64x2_mul(vw, wasm_f64x2_add(wasm_f64x2_splat(2.222219843214978396e-01),
                                                           wasm_f64x2_mul(vw, wasm_f64x2_splat(1.531383769920937332e-01))))));
  const v128_t vt2 = wasm_f64x2_mul(
      vz, wasm_f64x2_add(
              wasm_f64x2_splat(6.666666666666735130e-01),
              wasm_f64x2_mul(
                  vw, wasm_f64x2_add(wasm_f64x2_splat(2.857142874366239149e-01),
                                     wasm_f64x2_mul(vw, wasm_f64x2_add(wasm_f64x2_splat(1.818357216161805012e-01),
                                                                       wasm_f64x2_mul(vw, wasm_f64x2_splat(1.479819860511658591e-01))))))));
  const v128_t vhfsq = wasm_f64x2_mul(wasm_f64x2_splat(0.5), wasm_f64x2_mul(vf, vf));
  const v128_t vinner = wasm_f64x2_sub(
      wasm_f64x2_sub(vhfsq, wasm_f64x2_add(wasm_f64x2_mul(vs, wasm_f64x2_add(vhfsq, wasm_f64x2_add(vt2, vt1))),
                                           wasm_f64x2_mul(vdk, wasm_f64x2_splat(1.90821492927058770002e-10)))),
      vf);
  return wasm_f64x2_sub(wasm_f64x2_mul(vdk, wasm_f64x2_splat(6.93147180369123816490e-01)), vinner);
}

[[gnu::always_inline]] inline v128_t exp4_f32x4(v128_t vx) {
  const v128_t v_min = wasm_f32x4_splat(-85.0f);
  const v128_t v_max = wasm_f32x4_splat(80.0f);
  const v128_t v_gt_min = wasm_f32x4_gt(vx, v_min);
  const v128_t vx_c = wasm_f32x4_min(wasm_f32x4_max(vx, v_min), v_max);
  const v128_t v_magic = wasm_f32x4_splat(12582912.0f);
  const v128_t v_bias = wasm_f32x4_add(wasm_f32x4_mul(vx_c, wasm_f32x4_splat(1.44269504f)), v_magic);
  const v128_t v_fn = wasm_f32x4_sub(v_bias, v_magic);
  const v128_t vr = wasm_f32x4_sub(wasm_f32x4_sub(vx_c, wasm_f32x4_mul(v_fn, wasm_f32x4_splat(0.693145751953125f))),
                                   wasm_f32x4_mul(v_fn, wasm_f32x4_splat(1.428606765330187e-6f)));
  v128_t vp = wasm_f32x4_add(wasm_f32x4_splat(0.0083333338f), wasm_f32x4_mul(vr, wasm_f32x4_splat(0.0013888889f)));
  vp = wasm_f32x4_add(wasm_f32x4_splat(0.041666668f), wasm_f32x4_mul(vr, vp));
  vp = wasm_f32x4_add(wasm_f32x4_splat(0.16666667f), wasm_f32x4_mul(vr, vp));
  vp = wasm_f32x4_add(wasm_f32x4_splat(0.5f), wasm_f32x4_mul(vr, vp));
  vp = wasm_f32x4_add(wasm_f32x4_splat(1.0f), wasm_f32x4_mul(vr, vp));
  vp = wasm_f32x4_add(wasm_f32x4_splat(1.0f), wasm_f32x4_mul(vr, vp));
  const v128_t v_scale = wasm_i32x4_shl(wasm_i32x4_sub(v_bias, wasm_i32x4_splat(0x4b400000 - 127)), 23);
  return wasm_v128_and(wasm_f32x4_mul(vp, v_scale), v_gt_min);
}

[[gnu::always_inline]] inline v128_t log4_f32x4(v128_t vx) {
  const v128_t vu_adj = wasm_i32x4_add(vx, wasm_i32x4_splat(0x004afb0d));
  const v128_t vdk = wasm_f32x4_convert_i32x4(wasm_i32x4_sub(wasm_u32x4_shr(vu_adj, 23), wasm_i32x4_splat(127)));
  const v128_t vm = wasm_i32x4_add(wasm_v128_and(vu_adj, wasm_i32x4_splat(0x007fffff)), wasm_i32x4_splat(0x3f3504f3));
  const v128_t vf = wasm_f32x4_sub(vm, wasm_f32x4_splat(1.0f));
  const v128_t vs = wasm_f32x4_div(vf, wasm_f32x4_add(wasm_f32x4_splat(2.0f), vf));
  const v128_t vz = wasm_f32x4_mul(vs, vs);
  const v128_t vhfsq = wasm_f32x4_mul(wasm_f32x4_splat(0.5f), wasm_f32x4_mul(vf, vf));
  const v128_t vp = wasm_f32x4_mul(
      vz, wasm_f32x4_add(wasm_f32x4_splat(0.66666667f),
                         wasm_f32x4_mul(vz, wasm_f32x4_add(wasm_f32x4_splat(0.4f),
                                                           wasm_f32x4_mul(vz, wasm_f32x4_add(wasm_f32x4_splat(0.2857143f),
                                                                                             wasm_f32x4_mul(vz, wasm_f32x4_splat(0.2222222f))))))));
  const v128_t vinner = wasm_f32x4_sub(
      wasm_f32x4_sub(vhfsq, wasm_f32x4_add(wasm_f32x4_mul(vs, wasm_f32x4_add(vhfsq, vp)),
                                           wasm_f32x4_mul(vdk, wasm_f32x4_splat(1.428606765330187e-6f)))),
      vf);
  return wasm_f32x4_sub(wasm_f32x4_mul(vdk, wasm_f32x4_splat(0.693145751953125f)), vinner);
}
#endif

inline double atan(double x) {
  constexpr double kAtanHi[4] = {
      4.63647609000806093515e-01, 7.85398163397448278999e-01,
      9.82793723247329054082e-01, 1.57079632679489655800e+00};
  constexpr double kAtanLo[4] = {
      2.26987774529616870924e-17, 3.06161699786838301793e-17,
      1.39033110312309984516e-17, 6.12323399573676603587e-17};
  constexpr double a0 = 3.33333333333329318027e-01, a1 = -1.99999999998764832476e-01,
                   a2 = 1.42857142725034663711e-01, a3 = -1.11111104054623557880e-01,
                   a4 = 9.09088713343650656196e-02, a5 = -7.69187620504482999495e-02,
                   a6 = 6.66107313738753120669e-02, a7 = -5.83357013379057348645e-02,
                   a8 = 4.97687799461593236017e-02, a9 = -3.65315727442169155270e-02,
                   a10 = 1.62858201153657823623e-02;
  const double ax = std::fabs(x);
  if (!(ax < 1e300)) return std::atan(x);
  int id = -1;
  double u = ax;
  if (ax >= 0.4375) {
    if (ax < 2.4375) {
      if (ax < 0.6875) {
        id = 0;
        u = (2.0 * ax - 1.0) / (2.0 + ax);
      } else if (ax < 1.1875) {
        id = 1;
        u = (ax - 1.0) / (ax + 1.0);
      } else {
        id = 2;
        u = (ax - 1.5) / (1.0 + 1.5 * ax);
      }
    } else {
      id = 3;
      u = -1.0 / ax;
    }
  }
  const double z = u * u, w = z * z;
  const double s1 = z * (a0 + w * (a2 + w * (a4 + w * (a6 + w * (a8 + w * a10)))));
  const double s2 = w * (a1 + w * (a3 + w * (a5 + w * (a7 + w * a9))));
  const double r = id < 0 ? u - u * (s1 + s2) : kAtanHi[id] - ((u * (s1 + s2) - kAtanLo[id]) - u);
  return x < 0.0 ? -r : r;
}

inline double atan2(double y, double x) {
  const double ax = std::fabs(x), ay = std::fabs(y);
  if (!(ax + ay < 1e300)) return std::atan2(y, x);
  if (x > 0.0) return atan(y / x);
  if (x < 0.0) {
    constexpr double kPiHi = 3.14159265358979311600e+00;
    constexpr double kPiLo = 1.22464679914735320717e-16;
    const double r = atan(ay / ax);
    const double v = kPiHi - (r - kPiLo);
    return y < 0.0 ? -v : v;
  }
  if (y == 0.0) return std::atan2(y, x);
  return y < 0.0 ? -1.5707963267948966 : 1.5707963267948966;
}

}  // namespace fm
}  // namespace sdnap
