// -----------------------------------------------------------------------------
// SPEC 3: drag. The generic flux model (3.1), the Jacchia (1970) exospheric
// temperature (3.2), the density as log10 rho on the SPEC 3.3 grid, and the
// orbit average by 13-point Gauss-Legendre quadrature in true anomaly (3.4).
//
// The density table (SPEC 3.3): at 90-2500 km the printed Table 6 of SAO Special
// Report 313 (Jacchia 1970), transcribed in j70_table6.inc; at 10-85 km the US
// Standard Atmosphere 1976 densities as the 1976 tables print them (five
// significant digits), their logarithms to nine decimals (SPEC 3.3, amendment
// 6); below 10 km the 10 km node, above 2500 km 1e-20 kg/m^3.
// -----------------------------------------------------------------------------

namespace sdnap {
namespace drag {

/// Conformance diagnostics (test/conformance.e2e.mjs); the defaults change nothing.
struct Diagnostics {
  int hemisphere_flip = 0;  ///< 1: the seasonal term's hemisphere flipped at the equator node (|phi| < 1e-14)
  int record_cells = 0;     ///< 1: mark the density-table cells the lookups use
  uint8_t cells[29 * 111] = {};  ///< [temperature column][height node]
};
inline Diagnostics& diagnostics() {
  static Diagnostics d;
  return d;
}

constexpr int kTemps = 29;     // 600 to 2000 K every 50 K
constexpr int kHeights = 111;  // SPEC 3.3

/// SPEC 3.3 height nodes H_1..H_111 (km): 10 to 2500; H_0 = 0.
inline const double* table_heights() {
  static double h[kHeights];
  static bool built = false;
  if (!built) {
    int k = 0;
    for (double z = 10.0; z <= 90.0; z += 5.0) h[k++] = z;
    for (double z = 92.0; z <= 110.0; z += 2.0) h[k++] = z;
    for (double z = 115.0; z <= 160.0; z += 5.0) h[k++] = z;
    for (double z = 170.0; z <= 400.0; z += 10.0) h[k++] = z;
    for (double z = 420.0; z <= 1000.0; z += 20.0) h[k++] = z;
    for (double z = 1050.0; z <= 1500.0; z += 50.0) h[k++] = z;
    for (double z = 1600.0; z <= 2500.0; z += 100.0) h[k++] = z;
    built = true;
  }
  return h;
}

#include "j70_table6.inc"
#include "j70_library_overrides.inc"

/// US Standard Atmosphere 1976 densities (kg/m^3) at the 10-85 km nodes (SPEC 3.3).
inline double ussa76_log(double z) {
  static const double zs[] = {10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80, 85};
  static const double rho[] = {0.41351, 0.19476, 0.088910, 0.040084, 0.018410, 0.0084634, 0.0039957, 0.0019663,
                               0.0010269, 5.6810e-4, 3.0968e-4, 1.6321e-4, 8.2829e-5, 3.9921e-5, 1.8458e-5, 8.2196e-6};
  for (int k = 0; k < 16; ++k)
    if (std::fabs(zs[k] - z) < 1e-9) return std::log10(rho[k] * 1e-3);
  return std::log10(1.2250e-3);
}

/// The tables, built once: log10 rho (g/cm^3) at (H_r, T_c): USSA 1976 at 10-85 km
/// (unrounded), SR 313 Table 6 at 90-2500 km (three decimals). `library` applies the
/// library's own values (j70_library_overrides.inc; SGP4XP), otherwise the
/// printed ones.
inline const double* table(bool library = true) {
  static double printed[kTemps * kHeights], lib[kTemps * kHeights];
  static bool built = false;
  if (!built) {
    const double* hs = table_heights();
    constexpr int first = kHeights - kTable6Heights;  // H_17 = 90 km
    for (int it = 0; it < kTemps; ++it) {
      for (int k = 0; k < first; ++k) printed[it * kHeights + k] = std::round(ussa76_log(hs[k]) * 1e9) / 1e9;
      for (int k = 0; k < kTable6Heights; ++k) printed[it * kHeights + first + k] = kTable6[k][it] / 1000.0;
    }
    for (int i = 0; i < kTemps * kHeights; ++i) lib[i] = printed[i];
    for (const J70Override& o : kJ70LibraryOverrides) {
      int k = first;
      while (k < kHeights && static_cast<int>(hs[k]) != o.h) ++k;
      const int it = (o.T - 600) / 50;
      lib[it * kHeights + k] = o.library / 1000.0;
    }
    built = true;
  }
  return library ? lib : printed;
}

/// log10 rho (g/cm^3) at (tinf, h): linear in tinf between temperature nodes,
/// linear in h between the height nodes of the SPEC 3.3 band lookup; below
/// 10 km the 10 km node (the rates take 1e-20 kg/m^3 above 2500 km).
inline double log_density(double tinf, double h, bool library = true) {
  const double* tab = table(library);
  const double* hs = table_heights();
  // below 10 km, negative heights included, the 10 km node at every T_inf (SPEC 3.3, amendment 6: the lowest interval
  // is not interpolated)
  if (h < 10.0) return tab[0];
  double B, S, I;
  if (h < 90.0) { B = 10.0; S = 5.0; I = 2.0; }
  else if (h < 110.0) { B = 90.0; S = 2.0; I = 18.0; }
  else if (h < 160.0) { B = 110.0; S = 5.0; I = 28.0; }
  else if (h < 400.0) { B = 160.0; S = 10.0; I = 38.0; }
  else if (h < 1000.0) { B = 400.0; S = 20.0; I = 62.0; }
  else if (h < 1500.0) { B = 1000.0; S = 50.0; I = 92.0; }
  else { B = 1500.0; S = 100.0; I = 102.0; }
  int r = static_cast<int>(std::floor((h - B) / S + I + 1e-5));
  if (r > kHeights) r = kHeights;
  if (r < 2) r = 2;
  double ti = (tinf - 600.0) / 50.0;
  if (ti < 0.0) ti = 0.0;
  if (ti > kTemps - 1) ti = kTemps - 1;
  int it = static_cast<int>(ti);
  if (it > kTemps - 2) it = kTemps - 2;
  const double qt = ti - it;
  auto node = [&](int row, int col) { return tab[row * kHeights + col - 1]; };  // col 1: H_1 = 10 km
  const double h0 = hs[r - 2], h1 = hs[r - 1];
  const double qh = (h - h0) / (h1 - h0);
  if (diagnostics().record_cells) {
    Diagnostics& dg = diagnostics();
    for (int dc = 0; dc < 2; ++dc)
      for (int dr = 0; dr < 2; ++dr) {
        const int col = it + dc, row = r - 1 + dr;  // row 0 is H_0 = 0 km (not a table node)
        if (row >= 1) dg.cells[col * 111 + row - 1] = 1;
      }
  }
  const double a = node(it, r - 1) * (1.0 - qh) + node(it, r) * qh;
  const double b = node(it + 1, r - 1) * (1.0 - qh) + node(it + 1, r) * qh;
  return a * (1.0 - qt) + b * qt;
}

// --- SPEC 3.1: generic flux model -------------------------------------------------

struct Flux {
  double f, fbar, ap;
};

inline Flux flux_at(double d50) {
  static const double A[9] = {3941.23, 45065.1, 1125.51, 11732.2, 11696.1, 1367.0, 8881.53, 3213.79, 5106.98};
  static const double P[9] = {2.10492, 3.20864, 1.51623, 2.81733, 2.15674, 1.11698, 3.06443, 2.18364, 2.10492};
  static const double Qc[9] = {2.85759, 5.10803, 2.34156, 3.66706, 5.01571, 3.21707, 4.09606, 3.29520, 3.67530};
  double y = (d50 - 25567.0) / 365.2425;
  int k = 7;
  while (y < 0.0) { y += 11.0; --k; }
  while (y >= 11.0) { y -= 11.0; ++k; }
  if (k > 8) k = 8;
  if (k < 0) k = 0;
  const double x = y / 11.0;
  const double fy = y - std::floor(y);
  const double annual = (1.0 + 0.01671 * std::cos(kTwoPi * fy)) / 0.999721;
  Flux fl{};
  fl.f = (A[k] * std::pow(x, P[k]) * std::pow(1.0 - x, Qc[k]) + 70.0) * annual * annual;
  fl.fbar = fl.f;
  fl.ap = 27.6558 * std::pow(x, 0.93682) * std::pow(1.0 - x, 0.92198) + 8.0;
  return fl;
}

/// Day of year minus one (fractional) and the days in that year, at d50.
inline void day_of_year(double d50, double& D, double& N) {
  const double jd = d50 + kJd1950;
  const double days = jd - 2440587.5;  // from 1970-01-01 0h
  const double dfloor = std::floor(days);
  // civil from days (Hinnant)
  int64_t z = static_cast<int64_t>(dfloor) + 719468;
  const int64_t era = (z >= 0 ? z : z - 146096) / 146097;
  const int64_t doe = z - era * 146097;
  const int64_t yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
  int64_t y = yoe + era * 400;
  const int64_t doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
  const int64_t mp = (5 * doy + 2) / 153;
  const int64_t m = mp + (mp < 10 ? 3 : -9);
  if (m <= 2) ++y;
  auto from_civil = [](int64_t yy, int64_t mm, int64_t dd) {
    yy -= mm <= 2;
    const int64_t er = (yy >= 0 ? yy : yy - 399) / 400;
    const int64_t ye = yy - er * 400;
    const int64_t dy = (153 * (mm + (mm > 2 ? -3 : 9)) + 2) / 5 + dd - 1;
    const int64_t de = ye * 365 + ye / 4 - ye / 100 + dy;
    return er * 146097 + de - 719468;
  };
  const double jan1 = static_cast<double>(from_civil(y, 1, 1));
  D = days - jan1;
  N = static_cast<double>(from_civil(y + 1, 1, 1) - from_civil(y, 1, 1));
}

/// SPEC 3.2 and 3.3 terms that depend on the date only (one per rate evaluation).
struct DateTerms {
  double tc, dtsa, dtg, D, N, seasonal;
};

inline DateTerms date_terms(const Flux& fl, double D, double N) {
  DateTerms d{};
  d.tc = 383.0 + 1.80 * fl.f + 1.52 * fl.fbar;
  const double frac = D / N;
  const double tsa = frac + 0.1145 * (std::pow((1.0 + std::sin(kTwoPi * frac + 342.3 * kDeg)) / 2.0, 2.16) - 0.5);
  d.dtsa = fl.fbar * (0.349 + 0.206 * std::sin(kTwoPi * tsa + 226.5 * kDeg)) * std::sin(2.0 * kTwoPi * tsa + 247.6 * kDeg);
  d.dtg = fl.ap + 100.0 * (1.0 - std::exp(-0.08 * fl.ap));
  d.D = D;
  d.N = N;
  d.seasonal = std::sin(kTwoPi * (D + 100.0) / N);
  return d;
}

/// SPEC 3.2: exospheric temperature at the latitude phi (sine sp, cosine cp >= 0),
/// the Sun's declination (sine sd, cosine cd >= 0) and the Sun-relative hour
/// angle H (radians). sin^2.5(|phi + dsun| / 2) and cos^2.5(|phi - dsun| / 2) by
/// the half-angle identities, u^(5/4) with u = (1 -/+ cos(phi +/- dsun)) / 2.
inline double exospheric_temperature(const DateTerms& dt, double sp, double cp, double sd, double cd, double H) {
  double u = 0.5 * (1.0 - (cp * cd - sp * sd));  // sin^2(|phi + dsun| / 2)
  double v = 0.5 * (1.0 + (cp * cd + sp * sd));  // cos^2(|phi - dsun| / 2)
  u = u < 0.0 ? 0.0 : (u > 1.0 ? 1.0 : u);
  v = v < 0.0 ? 0.0 : (v > 1.0 ? 1.0 : v);
  const double S = u * std::sqrt(std::sqrt(u));
  const double C = v * std::sqrt(std::sqrt(v));
  double tau = H - 37.0 * kDeg + 6.0 * kDeg * std::sin(H + 43.0 * kDeg);
  tau = tau - kTwoPi * std::floor((tau + kPi) / kTwoPi);
  if (tau <= -kPi) tau += kTwoPi;
  const double ch = std::cos(tau / 2.0);
  const double tl = dt.tc * (1.0 + 0.31 * (S + (C - S) * ch * ch * ch));
  double t = tl + dt.dtsa + dt.dtg + 2.41;
  if (t < 600.0) t = 600.0;
  if (t > 2000.0) t = 2000.0;
  return t;
}

/// Density (kg/m^3) at geodetic height h (km), latitude phi.
inline double density(const DateTerms& dt, double tinf, double h, double phi) {
  double lr = log_density(tinf, h);
  if (h > 90.0 && h < 300.0) {
    // SPEC 3.3: cos^2 of the (geodetic) latitude with the sign of the hemisphere, the equator counted north.
    const double c = std::cos(phi);
    double hemisphere = phi >= 0.0 ? 1.0 : -1.0;
    if (diagnostics().hemisphere_flip && std::fabs(phi) < 1e-14) hemisphere = -hemisphere;
    lr += (1.0 / 50.0) * (h - 90.0) * std::exp(-0.045 * (h - 90.0)) * dt.seasonal * c * c * hemisphere;
  }
  return std::exp((lr + 3.0) * 2.302585092994045684);  // 10^(lr + 3)
}

/// Geodetic latitude (rad) and height (km) of an inertial position in Earth radii
/// on the EGM-96 ellipsoid (SPEC 1.3), by Bowring's iteration.
inline void geodetic(double x, double y, double z, double& phi, double& h) {
  constexpr double f = 3.3528197529902951e-3;
  constexpr double a = 6378.1363;
  const double e2 = f * (2.0 - f);
  const double X = x * a, Y = y * a, Z = z * a;
  const double rxy = std::sqrt(X * X + Y * Y);
  phi = std::atan2(Z, rxy * (1.0 - e2));
  for (int k = 0; k < 6; ++k) {
    const double s = std::sin(phi);
    const double Nn = a / std::sqrt(1.0 - e2 * s * s);
    phi = std::atan2(Z + e2 * Nn * s, rxy);
  }
  const double s = std::sin(phi), c = std::cos(phi);
  const double Nn = a / std::sqrt(1.0 - e2 * s * s);
  h = std::fabs(c) > 1e-10 ? rxy / c - Nn : std::fabs(Z) - Nn * (1.0 - e2);
}

}  // namespace drag
}  // namespace sdnap
