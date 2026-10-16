// Independent truth for the $TDM decoder's end-to-end test: a two-way laser
// campaign on a known orbit, written as JSON for the test to turn into CRD
// text. Nothing here reads the decoder or the estimator's measurement
// geometry. The orbit is the analytic Kepler solution in universal variables
// (Vallado, Fundamentals of Astrodynamics and Applications, 4e, Algorithm 8),
// not the integrator the estimator is given; geometric two-way light time is
// solved with a fixed station and additive media/Shapiro range corrections
// (Orekit Range convention). Transmit tags use the total observed round trip;
// angles give the retarded direction at the receive instant. With `weather`
// the one-way range carries the Marini-Murray delay of the pass's weather at the true elevation
// of a geodetic station (the model is the estimator's own, validated against
// Orekit by native_conformance; the geometry around it is computed here).
//
// Time: the request epoch is 2026-10-11T00:00:37 TAI = 2026-10-11T00:00:00 UTC,
// t seconds after it. Labels in UTC, TAI, GPS and TT are written from integer
// nanoseconds.
#include "estimation.hpp"

#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <vector>

using namespace sdn::estimation;

namespace {

constexpr double kMu = 3.986004418e14;
constexpr double kPi = 3.14159265358979323846;
constexpr double kC = kSpeedOfLight;

struct V { double x, y, z; };
V operator+(V a, V b) { return {a.x + b.x, a.y + b.y, a.z + b.z}; }
V operator-(V a, V b) { return {a.x - b.x, a.y - b.y, a.z - b.z}; }
V operator*(double s, V a) { return {s * a.x, s * a.y, s * a.z}; }
double dot(V a, V b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
double norm(V a) { return std::sqrt(dot(a, a)); }

double stumpff_c(double z) {
  if (z > 1e-8) return (1.0 - std::cos(std::sqrt(z))) / z;
  if (z < -1e-8) return (std::cosh(std::sqrt(-z)) - 1.0) / -z;
  return 0.5 - z / 24.0 + z * z / 720.0;
}
double stumpff_s(double z) {
  if (z > 1e-8) { const double s = std::sqrt(z); return (s - std::sin(s)) / (s * s * s); }
  if (z < -1e-8) { const double s = std::sqrt(-z); return (std::sinh(s) - s) / (s * s * s); }
  return 1.0 / 6.0 - z / 120.0 + z * z / 5040.0;
}

struct Orbit { V r0, v0; };

V position_at(const Orbit& o, double dt) {
  const double r0 = norm(o.r0), sqmu = std::sqrt(kMu);
  const double vr0 = dot(o.r0, o.v0) / r0;
  const double alpha = 2.0 / r0 - dot(o.v0, o.v0) / kMu;
  double chi = sqmu * dt * alpha;
  for (int i = 0; i < 100; ++i) {
    const double z = alpha * chi * chi, c = stumpff_c(z), s = stumpff_s(z);
    const double f = r0 * vr0 / sqmu * chi * chi * c + (1.0 - alpha * r0) * chi * chi * chi * s + r0 * chi - sqmu * dt;
    const double df = r0 * vr0 / sqmu * chi * (1.0 - z * s) + (1.0 - alpha * r0) * chi * chi * c + r0;
    const double step = f / df;
    chi -= step;
    if (std::abs(step) < 1e-12 * std::max(1.0, std::abs(chi))) break;
  }
  const double z = alpha * chi * chi, c = stumpff_c(z), s = stumpff_s(z);
  const double f = 1.0 - chi * chi / r0 * c;
  const double g = dt - chi * chi * chi / sqmu * s;
  return f * o.r0 + g * o.v0;
}

struct Geodetic { double lat, lon, h; };
V ecef(const Geodetic& g) {
  constexpr double a = 6378137.0, f = 1.0 / 298.257223563, e2 = f * (2.0 - f);
  const double n = a / std::sqrt(1.0 - e2 * std::sin(g.lat) * std::sin(g.lat));
  return {(n + g.h) * std::cos(g.lat) * std::cos(g.lon), (n + g.h) * std::cos(g.lat) * std::sin(g.lon),
          (n * (1.0 - e2) + g.h) * std::sin(g.lat)};
}
V up_of(const Geodetic& g) { return {std::cos(g.lat) * std::cos(g.lon), std::cos(g.lat) * std::sin(g.lon), std::sin(g.lat)}; }

struct Weather { double hpa, kelvin, percent; };

// Calendar labels of integer nanoseconds after 2026-10-11T00:00:00 in some scale.
void label(char* out, std::int64_t ns) {
  const std::int64_t whole = ns / 1000000000;
  std::snprintf(out, 40, "2026-10-11T%02d:%02d:%02d.%09d", static_cast<int>(whole / 3600), static_cast<int>(whole / 60 % 60),
                static_cast<int>(whole % 60), static_cast<int>(ns % 1000000000));
}

struct Point { std::int64_t tx_ns; double tof, t_b, t_rx, ra_deg, dec_deg; int pass; };

}  // namespace

int main(int argc, char** argv) {
  const bool weather_scenario = argc > 1 && std::strcmp(argv[1], "weather") == 0;
  // 800 km, 98 degrees, slightly eccentric; the elements are the state at t = 0.
  const double a = 7178137.0, speed = std::sqrt(kMu / a) * 1.02, inclination = 98.0 * kPi / 180.0;
  const Orbit orbit{{a, 0.0, 0.0}, {0.0, speed * std::cos(inclination), speed * std::sin(inclination)}};
  const double semi_major = 1.0 / (2.0 / a - speed * speed / kMu);
  const double period = 2.0 * kPi * std::sqrt(semi_major * semi_major * semi_major / kMu);

  // A station 10 degrees of latitude from the sub-satellite point at t = 1000 s.
  const V at = position_at(orbit, 1000.0);
  const Geodetic site{std::asin(at.z / norm(at)) + 10.0 * kPi / 180.0, std::atan2(at.y, at.x), 150.0};
  const V station = ecef(site);
  const V up = up_of(site);
  const Weather passes_weather[2] = {{1008.3, 281.4, 62.0}, {1002.1, 283.0, 55.0}};

  std::vector<Point> points;
  double minimum_elevation = 90.0;
  for (int pass = 0; pass < 2; ++pass) {
    const double centre = 1000.0 + pass * period;
    for (int k = -24; k <= 24; ++k) {
      const std::int64_t tx_ns = std::llround((centre + 5.0 * k) * 1e9);
      const double t_tx = tx_ns / 1e9;
      // R = rho + corrections; t_rx = t_tx + 2R/c and geometric
      // t_b = t_rx - rho/c imply t_b = t_tx + (R + corrections)/c.
      // Corrections enter the tag conversion, not the geometric light-time leg.
      double t_b = t_tx + 0.005, one_way = 0.0, delay = 0.0;
      for (int i = 0; i < 100; ++i) {
        const V s = position_at(orbit, t_b);
        const V los = s - station;
        const double range = norm(los);
        if (weather_scenario) {
          MediaEnvironment media;
          media.latitude_rad = site.lat;
          media.height_m = site.h;
          media.elevation_rad = std::asin(dot(up, los) / range);
          media.wavelength_m = 0.532e-6;
          media.pressure_hpa = passes_weather[pass].hpa;
          media.temperature_k = passes_weather[pass].kelvin;
          media.relative_humidity = passes_weather[pass].percent / 100.0;
          delay = marini_murray_delay_m(media);
        }
        // IERS Conventions 2010, section 11: Earth Shapiro range delay.
        // Both legs have the same fixed-station geometry, so their mean is
        // this one-leg correction, added alongside the weather delay.
        const double radii = norm(station) + norm(s);
        const double shapiro = (2.0 * kMu / (kC * kC)) *
            std::log((radii + range) / (radii - range));
        one_way = range + delay + shapiro;
        const double next = t_tx + (one_way + delay + shapiro) / kC;
        const double change = std::abs(next - t_b);
        t_b = next;
        if (change < 1e-16) break;
      }
      const V s = position_at(orbit, t_b);
      const double elevation = std::asin(dot(up, s - station) / norm(s - station)) * 180.0 / kPi;
      if (elevation < 10.0) continue;
      minimum_elevation = std::min(minimum_elevation, elevation);
      const double t_rx = t_tx + 2.0 * one_way / kC;
      // Angles at the receive instant, rounded to the nanosecond the label can say.
      const std::int64_t rx_ns = std::llround(t_rx * 1e9);
      double t_e = rx_ns / 1e9 - one_way / kC;
      for (int i = 0; i < 100; ++i) {
        const double next = rx_ns / 1e9 - norm(position_at(orbit, t_e) - station) / kC;
        const double change = std::abs(next - t_e);
        t_e = next;
        if (change < 1e-16) break;
      }
      const V d = position_at(orbit, t_e) - station;
      points.push_back({tx_ns, 2.0 * one_way / kC, t_b, t_rx,
                        std::atan2(d.y, d.x) * 180.0 / kPi, std::atan2(d.z, std::sqrt(d.x * d.x + d.y * d.y)) * 180.0 / kPi, pass});
    }
  }

  std::printf("{\n  \"reference\": {\"jd_day\": 2461324.5, \"seconds\": 37.0},\n");
  std::printf("  \"truth\": [%.17g, %.17g, %.17g, %.17g, %.17g, %.17g],\n", orbit.r0.x, orbit.r0.y, orbit.r0.z, orbit.v0.x, orbit.v0.y, orbit.v0.z);
  std::printf("  \"station\": [%.17g, %.17g, %.17g],\n", station.x, station.y, station.z);
  std::printf("  \"minimum_elevation_deg\": %.6f,\n", minimum_elevation);
  std::printf("  \"weather\": [");
  for (int i = 0; i < 2; ++i) {
    std::printf("%s{\"hpa\": %.4f, \"kelvin\": %.4f, \"percent\": %.4f}", i ? ", " : "", passes_weather[i].hpa, passes_weather[i].kelvin, passes_weather[i].percent);
  }
  std::printf("],\n  \"points\": [\n");
  for (std::size_t i = 0; i < points.size(); ++i) {
    const Point& p = points[i];
    char utc[40], tai[40], gps[40], tt[40], rx_utc[40], rx_tai[40], rx_gps[40], rx_tt[40];
    label(utc, p.tx_ns);
    label(tai, p.tx_ns + 37000000000LL);
    label(gps, p.tx_ns + 18000000000LL);          // GPS = TAI - 19 s = UTC + 18 s
    label(tt, p.tx_ns + 69184000000LL);           // TT = TAI + 32.184 s = UTC + 69.184 s
    const std::int64_t rx_ns = std::llround(p.t_rx * 1e9);
    label(rx_utc, rx_ns);
    label(rx_tai, rx_ns + 37000000000LL);
    label(rx_gps, rx_ns + 18000000000LL);
    label(rx_tt, rx_ns + 69184000000LL);
    // Preserve the noise-free truth: picosecond TOF rounding adds up to
    // 75 micrometres of one-way noise, amplified by this single-station fit.
    std::printf("    {\"pass\": %d, \"tx_utc\": \"%s\", \"tx_tai\": \"%s\", \"tx_gps\": \"%s\", \"tx_tt\": \"%s\", \"rx_utc\": \"%s\", \"rx_tai\": \"%s\", \"rx_gps\": \"%s\", \"rx_tt\": \"%s\", "
                "\"sod\": \"%.9f\", \"tof\": \"%.17g\", \"ra_deg\": \"%.13f\", \"dec_deg\": \"%.13f\"}%s\n",
                p.pass, utc, tai, gps, tt, rx_utc, rx_tai, rx_gps, rx_tt, p.tx_ns / 1e9, p.tof, p.ra_deg, p.dec_deg, i + 1 < points.size() ? "," : "");
  }
  std::printf("  ]\n}\n");
  return 0;
}
