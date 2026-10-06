// Independent fixture producer: native upstream ERFA, never CA module code.
// Reference matrix/EOP: higherpop/third_party/erfa/t_erfa_c.c::t_c2t06a.
// Synthetic EME2000 straight lines: A=(7000,7.5t,0), B=(7000.05,0,7.5t)
// km, t seconds from 2006-01-02T00:01:00 UTC. Analytic TCA=that epoch,
// miss=0.05 km. No operator or catalog input.
#include "erfa.h"
#include "nlohmann/json.hpp"
#include <array>
#include <cassert>
#include <cmath>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <sstream>
using json = nlohmann::json;
const double XP = 2.55060238e-7, YP = 1.860359247e-6, DUT = .3341,
             BASE = 2453737.5;
using Mat = std::array<std::array<double, 3>, 3>;
Mat direct_matrix(double day, double f, double shift, bool eme) {
  double t1, t2, tt1, tt2, u1, u2, c[3][3], b[3][3], p[3][3], bp[3][3];
  eraUtctai(day, f, &t1, &t2);
  eraTaitt(t1, t2, &tt1, &tt2);
  eraUtcut1(day, f, DUT, &u1, &u2);
  eraC2t06a(tt1, tt2 + shift / 86400., u1, u2 + shift / 86400., XP, YP, c);
  eraBp06(2451545., 0, b, p, bp);
  Mat r{};
  for (int i = 0; i < 3; ++i)
    for (int j = 0; j < 3; ++j) {
      if (eme)
        for (int k = 0; k < 3; ++k)
          r[i][j] += c[i][k] * b[j][k];
      else
        r[i][j] = c[i][j];
    }
  return r;
}
Mat matrix(double jd, double shift, bool eme) {
  return direct_matrix(std::floor(jd - .5) + .5,
                       jd - (std::floor(jd - .5) + .5), shift, eme);
}
void verify_published() {
  const double expected[3][3] = {
      {-.1810332128305897282, .9834769806938592296, .6555550962998436505e-4},
      {-.9834768134136214897, -.1810332203649130832, .5749800844905594110e-3},
      {.5773474024748545878e-3, .3961816829632690581e-4, .9999998325501747785}};
  double r[3][3];
  eraC2t06a(2400000.5, 53736., 2400000.5, 53736., XP, YP, r);
  for (int i = 0; i < 3; ++i)
    for (int j = 0; j < 3; ++j)
      assert(std::abs(r[i][j] - expected[i][j]) < 1e-12);
}
std::string iso(int second) {
  char b[80];
  std::snprintf(b, sizeof(b), "2006-01-02T00:%02d:%02d.000Z", second / 60,
                second % 60);
  return b;
}
std::string stamp(int second, bool shortYear) {
  char b[80];
  std::snprintf(b, sizeof(b), "%s00200%02d%02d.000", shortYear ? "06" : "2006",
                second / 60, second % 60);
  return b;
}
std::string values(const std::array<double, 6> &p) {
  std::ostringstream s;
  s << std::setprecision(17);
  for (double x : p)
    s << ' ' << x;
  return s.str();
}
std::array<double, 21> diagonal() {
  std::array<double, 21> c{};
  c[0] = .01;
  c[2] = .09;
  c[5] = .01;
  c[9] = c[14] = c[20] = 1e-6;
  return c;
}
std::string covtext(const std::array<double, 21> &c, bool itc) {
  std::ostringstream s;
  s << std::setprecision(17);
  size_t k = 0;
  for (int i = 0; i < (itc ? 3 : 6); ++i) {
    for (int n = 0; n < (itc ? 7 : i + 1); ++n) {
      if (n)
        s << ' ';
      s << c[k++];
    }
    s << '\n';
  }
  return s.str();
}
std::string header(const std::string &frame, const std::string &name) {
  return "CCSDS_OEM_VERS = 2.0\nCREATION_DATE = "
         "2006-01-01T00:00:00Z\nORIGINATOR = "
         "SYNTHETIC\nMETA_START\nOBJECT_NAME = " +
         name + "\nOBJECT_ID = " + name +
         "\nCENTER_NAME = EARTH\nREF_FRAME = " + frame +
         "\nTIME_SYSTEM = UTC\nMETA_STOP\n";
}
int main(int argc, char **argv) {
  assert(argc == 2);
  verify_published();
  std::filesystem::path dir = argv[1];
  std::filesystem::create_directories(dir);
  auto write = [&](std::string name, std::string value) {
    std::ofstream(dir / name) << value;
  };
  json oracle = {
      {"source", "Native ERFA eraC2t06a; independently compiled, checked "
                 "against all nine t_erfa_c.c::t_c2t06a matrix elements "
                 "(1e-12). No CA implementation used."},
      {"units", "km, km/s; JSON reference positions/velocities SI m,m/s"},
      {"epoch", "2006-01-02T00:01:00Z"},
      {"tca_jd", BASE + 60. / 86400.},
      {"reference_jd", BASE - 1. / 86400.},
      {"start_jd", BASE},
      {"miss_m", 50},
      {"eop",
       {{"MJD", 53737},
        {"UT1_MINUS_UTC_SECONDS_HP", DUT},
        {"X_POLE_WANDER_RADIANS_HP", XP},
        {"Y_POLE_WANDER_RADIANS_HP", YP},
        {"IAU_CONVENTION", "IAU_2006"}}}};
  for (int body = 0; body < 2; ++body) {
    std::string
        name = body ? "B" : "A",
        states, fixedStates,
        itc =
            "synthetic header 1\nsynthetic header 2\nsynthetic header 3\nUVW\n",
        nasa, utc = "time pos.x pos.y pos.z vel.x vel.y vel.z\n",
        jspoc = "JSpOC Format Ephemeris Report\nDate: "
                "2006-01-01T00:00:00Z\nSpacecraft: " +
                name + "\n",
        rtnCov, emeCov, fixedCov;
    for (int sec = 0; sec <= 120; sec += 10) {
      double jd = BASE + sec / 86400.,
             t = (jd - (BASE + 60. / 86400.)) * 86400.;
      std::array<double, 6> pv = {body ? 7000.05 : 7000., body ? 0 : 7.5 * t,
                                  body ? 7.5 * t : 0,     0,
                                  body ? 0 : 7.5,         body ? 7.5 : 0};
      double offset = (BASE - jd) * 86400. + sec;
      auto a = matrix(jd, offset, true), m2 = matrix(jd, offset - 2, true),
           m1 = matrix(jd, offset - 1, true), p1 = matrix(jd, offset + 1, true),
           p2 = matrix(jd, offset + 2, true);
      double j[6][6] = {};
      for (int i = 0; i < 3; ++i)
        for (int k = 0; k < 3; ++k) {
          j[i][k] = j[i + 3][k + 3] = a[i][k];
          j[i + 3][k] =
              (m2[i][k] - 8 * m1[i][k] + 8 * p1[i][k] - p2[i][k]) / 12.;
        }
      std::array<double, 6> fp{};
      for (int i = 0; i < 6; ++i)
        for (int k = 0; k < 6; ++k)
          fp[i] += j[i][k] * pv[k];
      states += iso(sec) + values(pv) + "\n";
      fixedStates += iso(sec) + values(fp) + "\n";
      nasa += stamp(sec, true) + values(pv) + "\n";
      jspoc += stamp(sec, true) + values(pv) + "\n";
      std::string u = iso(sec);
      u[4] = u[7] = '/';
      u[10] = ' ';
      u.pop_back();
      utc += u + values(pv) + "\n";
      itc += stamp(sec, false) + values(pv) + "\n" + covtext(diagonal(), true);
      rtnCov += "EPOCH = " + iso(sec) + "\nCOV_REF_FRAME = RTN\n" +
                covtext(diagonal(), false);
      emeCov += "EPOCH = " + iso(sec) + "\nCOV_REF_FRAME = EME2000\n" +
                covtext(diagonal(), false);
      double variances[6] = {.01, .09, .01, 1e-6, 1e-6, 1e-6};
      std::array<double, 21> fc{};
      size_t n = 0;
      for (int i = 0; i < 6; ++i)
        for (int k = 0; k <= i; ++k) {
          for (int z = 0; z < 6; ++z)
            fc[n] += j[i][z] * variances[z] * j[k][z];
          ++n;
        }
      fixedCov += "EPOCH = " + iso(sec) + "\nCOV_REF_FRAME = ITRF2020\n" +
                  covtext(fc, false);
      if (sec == 60 && body == 0) {
        // Independent known answer: ITRF [7000,0,0] km -> GCRF at tca.
        auto g = matrix(BASE, 0, false), g2 = matrix(BASE, -2, false),
             g1 = matrix(BASE, -1, false), h1 = matrix(BASE, 1, false),
             h2 = matrix(BASE, 2, false);
        json pos = json::array(), vel = json::array();
        for (int k = 0; k < 3; ++k) {
          pos.push_back(g[0][k] * 7000000.);
          vel.push_back((g2[0][k] - 8 * g1[0][k] + 8 * h1[0][k] - h2[0][k]) /
                        12. * 7000000.);
        }
        oracle["itrf_stationary_gcrf_position_m"] = pos;
        oracle["itrf_stationary_gcrf_velocity_m_s"] = vel;
      }
    }
    auto oem = [&](std::string frame, std::string st, std::string cov) {
      return header(frame, name) + st + "COVARIANCE_START\n" + cov +
             "COVARIANCE_STOP\n";
    };
    write(name + "-oem-eme2000.kvn", oem("EME2000", states, rtnCov));
    write(name + "-oem-itrf.kvn", oem("ITRF2020", fixedStates, rtnCov));
    write(name + "-oem-eme2000-cov.kvn", oem("EME2000", states, emeCov));
    write(name + "-oem-itrf-cov.kvn", oem("ITRF2020", fixedStates, fixedCov));
    write(name + "-itc.txt", itc);
    write(name + "-nasa.txt", nasa);
    write(name + "-utc.txt", utc);
    write(name + "-jspoc.txt", jspoc);
  }
  // Independent values on the exact binary64 UTC clock near each analytic
  // minimum. The screening solver may select a neighboring representable
  // epoch; compare states at that same epoch, never conflate search tolerance
  // with frame accuracy. No values from CA are used to construct this grid.
  oracle["evaluation_grid"] = json::array();
  oracle["gcrf_grid"] = json::array();
  for (int step = -64; step <= 64; ++step) {
    double ulp = std::nextafter(BASE, INFINITY) - BASE;
    double jd = BASE + 60. / 86400. + step * ulp;
    double t = (jd - (BASE + 60. / 86400.)) * 86400.;
    oracle["evaluation_grid"].push_back(
        {{"jd", jd},
         {"position_m", {7000000., 7500. * t, 0.}},
         {"velocity_m_s", {0., 7500., 0.}}});
    jd = BASE + step * ulp;
    auto g = matrix(jd, 0, false), g2 = matrix(jd, -2, false),
         g1 = matrix(jd, -1, false), h1 = matrix(jd, 1, false),
         h2 = matrix(jd, 2, false);
    json pos = json::array(), vel = json::array();
    for (int k = 0; k < 3; ++k) {
      pos.push_back(g[0][k] * 7000000.);
      vel.push_back((g2[0][k] - 8 * g1[0][k] + 8 * h1[0][k] - h2[0][k]) / 12. *
                    7000000.);
    }
    oracle["gcrf_grid"].push_back(
        {{"jd", jd}, {"position_m", pos}, {"velocity_m_s", vel}});
  }
  oracle["precision_cases"] = json::array();
  for (int kind = 0; kind < 2; ++kind) {
    int year = kind ? 2016 : 2006, month = kind ? 12 : 1, day = kind ? 31 : 2,
        hour = kind ? 23 : 0, minute = kind ? 59 : 0;
    double second = kind ? 0 : 10.123456789, u1, u2, j0, mjd;
    eraDtf2d("UTC", year, month, day, hour, minute, second, &u1, &u2);
    eraCal2jd(year, month, day, &j0, &mjd);
    double start = j0 + mjd + (hour * 3600. + minute * 60. + second) / 86400.;
    auto epoch = [&](double delta) {
      char b[64];
      std::snprintf(b, sizeof(b), "%04d-%02d-%02dT%02d:%02d:%012.9fZ", year,
                    month, day, hour, minute, second + delta);
      return std::string(b);
    };
    json c = {{"name", kind ? "UTC leap day" : "fractional UTC epoch"},
              {"start_jd", start},
              {"start", epoch(0)},
              {"stop", epoch(30)},
              {"eop", oracle["eop"]},
              {"grid", json::array()}};
    c["eop"]["MJD"] = int(mjd);
    for (int step = -64; step <= 64; ++step) {
      double jd = start + step * (std::nextafter(start, INFINITY) - start),
             shift = (jd - start) * 86400.;
      auto g = direct_matrix(u1, u2, shift, false);
      json pos = json::array();
      for (int k = 0; k < 3; ++k)
        pos.push_back(g[0][k] * 7000000.);
      c["grid"].push_back({{"jd", jd}, {"position_m", pos}});
    }
    oracle["precision_cases"].push_back(c);
  }
  write("reference.json", oracle.dump(2) + "\n");
}
