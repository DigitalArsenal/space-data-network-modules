// Native development probe for the whole operator fit (not a test): an HPOP
// truth written as a CCSDS OEM KVN (EME2000, UTC), read back and fitted.
//   operator_probe <env-dir> <span-hours> <step-s> [frame-error]
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <iterator>
#include <string>

#include "operator_fit.hpp"

using namespace odhpop;

static std::vector<uint8_t> slurp(const std::string& p) {
  std::ifstream f(p, std::ios::binary);
  return std::vector<uint8_t>((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
}

static void print(const char* name, const ResidualStats& s) {
  std::printf("  %-14s n %5zu span %7.0f s rms3d %.6f km rmsPerCoord %.6f R %.6f T %.6f N %.6f max %.6f\n", name, s.n,
              s.span_s, s.rms_3d_km, s.rms_per_coordinate_km, s.rms_r_km, s.rms_t_km, s.rms_n_km, s.max_3d_km);
}

int main(int argc, char** argv) {
  const std::string dir = argv[1];
  const double span_h = std::atof(argv[2]), step = std::atof(argv[3]);
  const bool frame_error = argc > 4;
  auto eop = slurp(dir + "/earth_orientation.prw"), sw = slurp(dir + "/space_weather.prw"),
       kernel = slurp(dir + "/kernel.prw");
  Environment env;
  env.earth_orientation = eop.data(), env.earth_orientation_size = eop.size();
  env.space_weather = sw.data(), env.space_weather_size = sw.size();
  env.kernel = kernel.data(), env.kernel_size = kernel.size();

  Solution truth;
  truth.epoch = utc_from_calendar(2026, 7, 2, 3, 0, 0.0);
  const double mu = 3.986004415e14, a = 6378137.0 + 550e3, inc = 53.05 * M_PI / 180, raan = 1.1;
  const double v = std::sqrt(mu / a);
  truth.state = {a * std::cos(raan), a * std::sin(raan), 0, -v * std::sin(raan) * std::cos(inc),
                 v * std::cos(raan) * std::cos(inc), v * std::sin(inc)};
  truth.params = default_parameters(truth.state, span_h * 3600, &truth.forces);
  for (auto& q : truth.params) q.value = q.id == Param::B ? 0.018 : q.id == Param::AGOM ? 0.011 : 0.0;
  std::vector<UtcEpoch> t;
  for (double x = 0; x <= span_h * 3600 + 1e-9; x += step) t.push_back(add_seconds(truth.epoch, x));
  std::vector<std::array<double, 6>> st;
  std::string error;
  if (!predict(truth, env, Integration(), t, &st, &error)) return std::printf("truth: %s\n", error.c_str()), 1;
  const Mat3 to_eme = transpose(eme2000_to_gcrf());
  std::string kvn = "CCSDS_OEM_VERS = 2.0\nCREATION_DATE = 2026-07-02T00:00:00\nORIGINATOR = SYNTHETIC\n\nMETA_START\n"
                    "OBJECT_NAME = SYNTH-1\nOBJECT_ID = 2026-999A\nCENTER_NAME = EARTH\nREF_FRAME = EME2000\n"
                    "TIME_SYSTEM = UTC\nMETA_STOP\n";
  for (std::size_t i = 0; i < t.size(); ++i) {
    double r[3] = {st[i][0], st[i][1], st[i][2]}, w[3] = {st[i][3], st[i][4], st[i][5]};
    auto re = rotate(frame_error ? gcrf_to_teme(t[i]) : to_eme, r);
    auto ve = rotate(frame_error ? gcrf_to_teme(t[i]) : to_eme, w);
    char line[256];
    std::snprintf(line, sizeof line, "%s %.9f %.9f %.9f %.12f %.12f %.12f\n", format_iso_utc(t[i], 3).c_str(),
                  re[0] / 1e3, re[1] / 1e3, re[2] / 1e3, ve[0] / 1e3, ve[1] / 1e3, ve[2] / 1e3);
    kvn += line;
  }
  OperatorFitOptions o;
  o.hpop_span_s = 0;
  o.omm_span_s = 6 * 3600;
  o.data_source = "SYNTH";
  Reference ref;
  if (frame_error) {
    // The "reference": an SGP4 fit to the correct TEME states.
    std::string correct = kvn;  // not used
    (void)correct;
  }
  OperatorFitResult r = fit_operator_ephemeris(reinterpret_cast<const uint8_t*>(kvn.data()), kvn.size(), ref, env, o);
  std::printf("ok %d %s %s sha %s samples %zu segments %zu\n", r.ok, r.failure_code.c_str(), r.failure_message.c_str(),
              r.raw_sha256.substr(0, 16).c_str(), r.samples, r.segments.size());
  std::printf(" SGP4 fit points %zu B* %.6e\n", r.sgp4.fit_points, r.sgp4.elements.bstar);
  print("sgp4", r.sgp4.stats);
  print("sgp4 half", r.sgp4.closure.first_half);
  print("sgp4 closure", r.sgp4.closure.second_half);
  std::printf(" HPOP iterations %d converged %d props %zu\n", r.hpop.fit.iterations, r.hpop.fit.converged,
              r.hpop.fit.propagations);
  for (const auto& p : r.hpop.fit.solution.params) std::printf("  %s = %.9e\n", param_name(p.id), p.value);
  print("hpop", r.hpop.stats);
  print("hpop half", r.hpop.closure.first_half);
  print("hpop closure", r.hpop.closure.second_half);
  for (const auto& ev : r.hpop.segment.evidence) std::printf("  evidence: %s\n", ev.c_str());
  return 0;
}
