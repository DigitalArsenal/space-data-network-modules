// Native development probe (not a test): SGP4-generated TEME ephemerides,
// written as OEM KVN, through the operator fit with HPOP off; the OMM half-fit
// closure on every second-half point.
//   sgp4_probe <cases> [seed]
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <random>
#include <string>

#include "operator_fit.hpp"

using namespace odhpop;

int main(int argc, char** argv) {
  const int cases = std::atoi(argv[1]);
  std::mt19937_64 rng(argc > 2 ? std::strtoull(argv[2], nullptr, 10) : 1);
  std::uniform_real_distribution<double> u(0, 1);
  int failures = 0;
  for (int k = 0; k < cases; ++k) {
    od::SGP4Elements el{};
    const int cls = k % 5;  // LEO-drag, LEO-upper, MEO, GEO, HEO
    const double n_rev[5] = {15.5, 13.2, 2.0, 1.0027, 2.006};
    el.mean_motion = n_rev[cls] * (1 + 0.01 * (u(rng) - 0.5));
    el.eccentricity = cls == 4 ? 0.7 + 0.04 * u(rng) : cls == 3 ? 3e-4 * u(rng) : 1e-3 * u(rng) + 1e-5;
    el.inclination = cls == 3 ? 0.05 + u(rng) : cls == 4 ? 63.4 : 20 + 80 * u(rng);
    el.ra_of_asc_node = 360 * u(rng);
    el.arg_of_pericenter = cls == 4 ? 270 : 360 * u(rng);
    el.mean_anomaly = 360 * u(rng);
    el.bstar = cls == 0 ? 2e-4 + 8e-4 * u(rng) : cls == 1 ? 1e-5 * u(rng) : 0.0;
    const UtcEpoch epoch = add_seconds(utc_from_calendar(2026, 7, 2, 0, 0, 0.0), 86400 * u(rng));
    el.epoch_jd = jd_single(epoch);
    el.epoch_iso = format_iso_utc(epoch, 6);
    const double period = 86400.0 / el.mean_motion;
    const double span = period * (1 + 6 * u(rng));  // one orbit and up
    const double steps[4] = {10, 60, 300, 900};
    double step = steps[k % 4];
    while (span / step < 24) step /= 2;
    std::string kvn = "CCSDS_OEM_VERS = 2.0\nMETA_START\nOBJECT_NAME = SYNTH\nOBJECT_ID = 2026-999A\nCENTER_NAME = EARTH\n"
                      "REF_FRAME = TEME\nTIME_SYSTEM = UTC\nMETA_STOP\n";
    for (double t = 0; t <= span; t += step) {
      std::array<double, 6> s{};
      const UtcEpoch at = add_seconds(epoch, t);
      if (!sgp4_at(el, epoch, at, &s)) break;
      char line[256];
      std::snprintf(line, sizeof line, "%s %.10f %.10f %.10f %.13f %.13f %.13f\n", format_iso_utc(at, 6).c_str(), s[0], s[1],
                    s[2], s[3], s[4], s[5]);
      kvn += line;
    }
    OperatorFitOptions o;
    o.hpop = false;
    o.omm_span_s = 0;
    o.omm_span_s = span + 1;
    Environment env;
    OperatorFitResult r = fit_operator_ephemeris(reinterpret_cast<const uint8_t*>(kvn.data()), kvn.size(), Reference(), env, o);
    const auto& c = r.sgp4.closure.second_half;
    const bool pass = r.ok && r.sgp4.closure.done && c.max_3d_km <= 1e-5;
    failures += !pass;
    std::printf("case %2d cls %d n %.4f e %.5f i %6.2f B* %.2e span %7.0f s step %4.0f: ok %d fit rms %.3e km closure max %.3f mm rms %.3f mm %s\n",
                k, cls, el.mean_motion, el.eccentricity, el.inclination, el.bstar, span, step, r.ok,
                r.sgp4.stats.rms_3d_km, c.max_3d_km * 1e6, c.rms_3d_km * 1e6, pass ? "PASS" : "FAIL");
    if (!r.ok) std::printf("   %s %s\n", r.failure_code.c_str(), r.failure_message.c_str());
  }
  std::printf("failures %d / %d\n", failures, cases);
  return failures ? 3 : 0;
}
