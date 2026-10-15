#pragma once
// The map projections a GeoTIFF is read in: geographic (EPSG 4326 and the
// GRS80 datums treated as it: 4269, 4258), Web Mercator (3857 and its older
// codes) and UTM on WGS84 (326xx north, 327xx south) or GRS80 (NAD83 269xx,
// ETRS89 258xx). Transverse Mercator is Krüger's series to sixth order in n as
// given by Karney (2011), "Transverse Mercator with an accuracy of a few
// nanometers", J. Geodesy 85:475-485, eqs. 7-11 (forward) and 15-18 with the
// Newton step of eq. 19 (inverse); accurate to about 5 nm within 3,900 km of
// the central meridian.

#include <cmath>
#include <cstdint>

namespace project {

enum class Kind { Unsupported, Geographic, WebMercator, Utm };

struct Crs {
  Kind kind = Kind::Unsupported;
  int epsg = 0;
  int zone = 0;
  bool south = false;
  double a = 6378137.0;
  double f = 1.0 / 298.257223563;
};

inline Crs fromEpsg(int epsg) {
  Crs c;
  c.epsg = epsg;
  if (epsg == 4326 || epsg == 4269 || epsg == 4258) c.kind = Kind::Geographic;
  else if (epsg == 3857 || epsg == 900913 || epsg == 3785 || epsg == 102100 || epsg == 102113) c.kind = Kind::WebMercator;
  else if (epsg >= 32601 && epsg <= 32660) { c.kind = Kind::Utm; c.zone = epsg - 32600; }
  else if (epsg >= 32701 && epsg <= 32760) { c.kind = Kind::Utm; c.zone = epsg - 32700; c.south = true; }
  else if (epsg >= 26901 && epsg <= 26923) { c.kind = Kind::Utm; c.zone = epsg - 26900; c.f = 1.0 / 298.257222101; }
  else if (epsg >= 25828 && epsg <= 25838) { c.kind = Kind::Utm; c.zone = epsg - 25800; c.f = 1.0 / 298.257222101; }
  return c;
}

constexpr double kPi = 3.14159265358979323846;
constexpr double kDeg = kPi / 180.0;
constexpr double kWebMercatorRadius = 6378137.0;

struct Tm {
  double k0 = 0.9996, fe = 500000.0, fn = 0.0, lon0 = 0.0;
  double e = 0.0, A = 0.0;
  double alpha[7] = {0}, beta[7] = {0};

  explicit Tm(const Crs& c) {
    const double n = c.f / (2.0 - c.f), n2 = n * n, n3 = n2 * n, n4 = n3 * n, n5 = n4 * n, n6 = n5 * n;
    e = std::sqrt(c.f * (2.0 - c.f));
    A = c.a / (1.0 + n) * (1.0 + n2 / 4.0 + n4 / 64.0 + n6 / 256.0);
    alpha[1] = n / 2 - 2 * n2 / 3 + 5 * n3 / 16 + 41 * n4 / 180 - 127 * n5 / 288 + 7891 * n6 / 37800;
    alpha[2] = 13 * n2 / 48 - 3 * n3 / 5 + 557 * n4 / 1440 + 281 * n5 / 630 - 1983433 * n6 / 1935360;
    alpha[3] = 61 * n3 / 240 - 103 * n4 / 140 + 15061 * n5 / 26880 + 167603 * n6 / 181440;
    alpha[4] = 49561 * n4 / 161280 - 179 * n5 / 168 + 6601661 * n6 / 7257600;
    alpha[5] = 34729 * n5 / 80640 - 3418889 * n6 / 1995840;
    alpha[6] = 212378941 * n6 / 319334400;
    beta[1] = n / 2 - 2 * n2 / 3 + 37 * n3 / 96 - n4 / 360 - 81 * n5 / 512 + 96199 * n6 / 604800;
    beta[2] = n2 / 48 + n3 / 15 - 437 * n4 / 1440 + 46 * n5 / 105 - 1118711 * n6 / 3870720;
    beta[3] = 17 * n3 / 480 - 37 * n4 / 840 - 209 * n5 / 4480 + 5569 * n6 / 90720;
    beta[4] = 4397 * n4 / 161280 - 11 * n5 / 504 - 830251 * n6 / 7257600;
    beta[5] = 4583 * n5 / 161280 - 108847 * n6 / 3991680;
    beta[6] = 20648693 * n6 / 638668800;
    lon0 = (-183.0 + 6.0 * c.zone) * kDeg;
    fn = c.south ? 10000000.0 : 0.0;
  }

  void forward(double lon, double lat, double* x, double* y) const {
    const double phi = lat * kDeg, lam = lon * kDeg - lon0;
    const double s = std::sin(phi);
    const double t = std::sinh(std::atanh(s) - e * std::atanh(e * s));
    const double xi = std::atan2(t, std::cos(lam));
    const double eta = std::atanh(std::sin(lam) / std::sqrt(1.0 + t * t));
    double X = xi, Y = eta;
    for (int j = 1; j <= 6; ++j) {
      X += alpha[j] * std::sin(2 * j * xi) * std::cosh(2 * j * eta);
      Y += alpha[j] * std::cos(2 * j * xi) * std::sinh(2 * j * eta);
    }
    *x = fe + k0 * A * Y;
    *y = fn + k0 * A * X;
  }

  void inverse(double x, double y, double* lon, double* lat) const {
    const double xi = (y - fn) / (k0 * A), eta = (x - fe) / (k0 * A);
    double xp = xi, ep = eta;
    for (int j = 1; j <= 6; ++j) {
      xp -= beta[j] * std::sin(2 * j * xi) * std::cosh(2 * j * eta);
      ep -= beta[j] * std::cos(2 * j * xi) * std::sinh(2 * j * eta);
    }
    const double tp = std::sin(xp) / std::sqrt(std::sinh(ep) * std::sinh(ep) + std::cos(xp) * std::cos(xp));
    const double lam = std::atan2(std::sinh(ep), std::cos(xp));
    const double e2 = e * e;
    double tau = tp;
    for (int i = 0; i < 6; ++i) {
      const double sigma = std::sinh(e * std::atanh(e * tau / std::sqrt(1 + tau * tau)));
      const double tpi = tau * std::sqrt(1 + sigma * sigma) - sigma * std::sqrt(1 + tau * tau);
      const double d = (tp - tpi) / std::sqrt(1 + tpi * tpi) * (1 + (1 - e2) * tau * tau) / ((1 - e2) * std::sqrt(1 + tau * tau));
      tau += d;
      if (std::fabs(d) < 1e-14) break;
    }
    *lat = std::atan(tau) / kDeg;
    *lon = (lam + lon0) / kDeg;
  }
};

// Geographic degrees -> the CRS's own coordinates (degrees for geographic, metres otherwise).
struct Projector {
  Crs crs;
  Tm tm;
  explicit Projector(const Crs& c) : crs(c), tm(c) {}

  void forward(double lon, double lat, double* x, double* y) const {
    switch (crs.kind) {
      case Kind::Geographic: *x = lon; *y = lat; return;
      case Kind::WebMercator: {
        const double clamped = std::fmax(-85.0511287798, std::fmin(85.0511287798, lat));
        *x = kWebMercatorRadius * lon * kDeg;
        *y = kWebMercatorRadius * std::log(std::tan(kPi / 4 + clamped * kDeg / 2));
        return;
      }
      case Kind::Utm: tm.forward(lon, lat, x, y); return;
      default: *x = *y = NAN;
    }
  }

  void inverse(double x, double y, double* lon, double* lat) const {
    switch (crs.kind) {
      case Kind::Geographic: *lon = x; *lat = y; return;
      case Kind::WebMercator:
        *lon = x / kWebMercatorRadius / kDeg;
        *lat = std::atan(std::sinh(y / kWebMercatorRadius)) / kDeg;
        return;
      case Kind::Utm: tm.inverse(x, y, lon, lat); return;
      default: *lon = *lat = NAN;
    }
  }
};

}  // namespace project
