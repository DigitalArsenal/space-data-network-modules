// The chi-square distribution with m degrees of freedom through the
// regularized incomplete gamma function (Abramowitz and Stegun 6.5.29 series
// and 6.5.31 continued fraction, evaluated as in Numerical Recipes 6.2):
//   CDF(x) = P(m/2, x/2),  tail(x) = Q(m/2, x/2) = 1 - P,
// and its quantile, the gate: the x with CDF(x) = p, by safeguarded Newton.
namespace assoc {

// P(a, x) and Q(a, x), a > 0, x >= 0, each to about 1e-15 relative.
inline void incompleteGamma(double a, double x, double* p, double* q) {
  if (x <= 0.0) { *p = 0.0; *q = 1.0; return; }
  const double lead = a * std::log(x) - x - std::lgamma(a);
  if (x < a + 1.0) {
    double ap = a, sum = 1.0 / a, del = sum;
    for (int n = 0; n < 1000; ++n) {
      ap += 1.0;
      del *= x / ap;
      sum += del;
      if (std::fabs(del) < std::fabs(sum) * 1e-17) break;
    }
    *p = sum * std::exp(lead);
    *q = 1.0 - *p;
    return;
  }
  // Lentz's method for the continued fraction of Q.
  const double tiny = 1e-300;
  double b = x + 1.0 - a, c = 1.0 / tiny, d = 1.0 / b, h = d;
  for (int i = 1; i < 1000; ++i) {
    const double an = -i * (i - a);
    b += 2.0;
    d = an * d + b;
    if (std::fabs(d) < tiny) d = tiny;
    c = b + an / c;
    if (std::fabs(c) < tiny) c = tiny;
    d = 1.0 / d;
    const double del = d * c;
    h *= del;
    if (std::fabs(del - 1.0) < 1e-17) break;
  }
  *q = std::exp(lead) * h;
  *p = 1.0 - *q;
}

inline double chiSquareCdf(double x, int dof) {
  double p, q;
  incompleteGamma(0.5 * dof, 0.5 * x, &p, &q);
  return p;
}

inline double chiSquareTail(double x, int dof) {
  double p, q;
  incompleteGamma(0.5 * dof, 0.5 * x, &p, &q);
  return q;
}

inline double chiSquareDensity(double x, int dof) {
  if (x <= 0.0) return 0.0;
  const double k = 0.5 * dof;
  return std::exp((k - 1.0) * std::log(x) - 0.5 * x - k * std::log(2.0) - std::lgamma(k));
}

// The gate: x such that CDF(x) = probability, 0 < probability < 1.
inline double chiSquareQuantile(double probability, int dof) {
  double lo = 0.0, hi = dof + 10.0;
  while (chiSquareCdf(hi, dof) < probability) hi *= 2.0;
  double x = dof;  // the mean, a starting point inside the bracket
  for (int i = 0; i < 200; ++i) {
    const double f = chiSquareCdf(x, dof) - probability;
    if (f > 0.0) hi = x; else lo = x;
    const double density = chiSquareDensity(x, dof);
    double next = density > 0.0 ? x - f / density : 0.5 * (lo + hi);
    if (!(next > lo && next < hi)) next = 0.5 * (lo + hi);
    if (std::fabs(next - x) <= 1e-14 * std::fmax(1.0, x)) return next;
    x = next;
  }
  return x;
}

}  // namespace assoc
