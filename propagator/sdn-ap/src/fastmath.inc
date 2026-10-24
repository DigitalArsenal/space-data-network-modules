// -----------------------------------------------------------------------------
// sincos: the sine and cosine of one argument from one range reduction
// (Cody-Waite in three parts of pi/2) and the minimax kernels of FDLIBM
// (k_sin.c, k_cos.c; error below one unit in the last place). Arguments
// beyond 2^20 pi/2 fall back to the library functions.
// -----------------------------------------------------------------------------

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

inline int exponent_bits(double x) {
  uint64_t u;
  std::memcpy(&u, &x, 8);
  return static_cast<int>((u >> 52) & 0x7ff);
}

inline double ksin(double x, double y, bool tail) {
  constexpr double S1 = -1.66666666666666324348e-01, S2 = 8.33333333332248946124e-03,
                   S3 = -1.98412698298579493134e-04, S4 = 2.75573137070700676789e-06,
                   S5 = -2.50507602534068634195e-08, S6 = 1.58969099521155010221e-10;
  const double z = x * x, w = z * z;
  const double r = S2 + z * (S3 + z * S4) + z * w * (S5 + z * S6);
  const double v = z * x;
  if (!tail) return x + v * (S1 + z * r);
  return x - ((z * (0.5 * y - v * r) - y) - v * S1);
}

inline double kcos(double x, double y) {
  constexpr double C1 = 4.16666666666666019037e-02, C2 = -1.38888888888741095749e-03,
                   C3 = 2.48015872894767294178e-05, C4 = -2.75573143513906633035e-07,
                   C5 = 2.08757232129817482790e-09, C6 = -1.13596475577881948265e-11;
  const double z = x * x, w = z * z;
  const double r = z * (C1 + z * (C2 + z * C3)) + w * w * (C4 + z * (C5 + z * C6));
  const double hz = 0.5 * z;
  const double ww = 1.0 - hz;
  return ww + (((1.0 - ww) - hz) + (z * r - x * y));
}

inline void sincos(double x, double& s, double& c) {
  const double ax = std::fabs(x);
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

}  // namespace fm
}  // namespace sdnap
