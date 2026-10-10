// Native development probe for the HPOP fit (not a test): generates an HPOP
// ephemeris with every force on, fits the first half from a perturbed guess,
// and scores the second half on every point.
//
//   closure_probe <env-dir> <regime> <span-hours> <step-s> [max-fit-points]
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <iterator>
#include <string>
#include <vector>

#include "../../src/hpop_fit.hpp"
#include "../../src/residual_stats.hpp"

using namespace odhpop;

static std::vector<uint8_t> slurp(const std::string& p) {
  std::ifstream f(p, std::ios::binary);
  return std::vector<uint8_t>((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
}

int main(int argc, char** argv) {
  if (argc < 5) return 2;
  const std::string dir = argv[1], regime = argv[2];
  const double span_h = std::atof(argv[3]), step = std::atof(argv[4]);
  const std::size_t max_points = argc > 5 ? std::strtoul(argv[5], nullptr, 10) : 720;
  auto eop = slurp(dir + "/earth_orientation.prw"), sw = slurp(dir + "/space_weather.prw"),
       kernel = slurp(dir + "/kernel.prw"), jb = slurp(dir + "/jb2008_indices.prw");
  Environment env;
  env.earth_orientation = eop.data();
  env.earth_orientation_size = eop.size();
  env.space_weather = sw.data();
  env.space_weather_size = sw.size();
  env.kernel = kernel.data();
  env.kernel_size = kernel.size();

  Solution truth;
  truth.epoch = utc_from_calendar(2026, 7, 1, 0, 0, 0.0);
  const double mu = 3.986004415e14, re = 6378137.0;
  double a = re + 420e3, e = 0.0005, inc = 51.6 * M_PI / 180;
  if (regime == "leo-upper") a = re + 1200e3, inc = 87.9 * M_PI / 180;
  if (regime == "meo") a = 26560e3, e = 0.01, inc = 55 * M_PI / 180;
  if (regime == "geo") a = 42164e3, e = 0.0002, inc = 0.05 * M_PI / 180;
  if (regime == "heo") a = 26600e3, e = 0.74, inc = 63.4 * M_PI / 180;
  const double raan = 0.7, argp = 4.0, nu = 0.3;
  const double p = a * (1 - e * e), r = p / (1 + e * std::cos(nu));
  const double rp[3] = {r * std::cos(nu), r * std::sin(nu), 0};
  const double vp[3] = {-std::sqrt(mu / p) * std::sin(nu), std::sqrt(mu / p) * (e + std::cos(nu)), 0};
  const double cO = std::cos(raan), sO = std::sin(raan), cw = std::cos(argp), sw2 = std::sin(argp), ci = std::cos(inc), si = std::sin(inc);
  const double R[3][3] = {{cO * cw - sO * sw2 * ci, -cO * sw2 - sO * cw * ci, sO * si},
                          {sO * cw + cO * sw2 * ci, -sO * sw2 + cO * cw * ci, -cO * si},
                          {sw2 * si, cw * si, ci}};
  for (int i = 0; i < 3; ++i) {
    truth.state[i] = R[i][0] * rp[0] + R[i][1] * rp[1];
    truth.state[3 + i] = R[i][0] * vp[0] + R[i][1] * vp[1];
  }
  if (std::getenv("NO_ER")) truth.forces.earth_radiation = false;
  if (std::getenv("NO_OT")) truth.forces.ocean_tide_degree = 0;
  if (std::getenv("NO_DRAG")) truth.forces.drag = false, env.space_weather = nullptr, env.space_weather_size = 0;
  if (std::getenv("NO_SRP")) truth.forces.srp = false;
  if (std::getenv("NO_ST")) truth.forces.solid_tides = false;
  if (std::getenv("NO_3B")) truth.forces.sun = truth.forces.moon = truth.forces.venus = truth.forces.mars = truth.forces.jupiter = false;
  if (std::getenv("DEG")) truth.forces.degree = truth.forces.order = std::atoi(std::getenv("DEG"));
  truth.params = default_parameters(truth.state, span_h * 1800, &truth.forces);
  for (auto& q : truth.params) {
    if (q.id == Param::B) q.value = 0.021;
    if (q.id == Param::AGOM) q.value = 0.013;
    if (q.id == Param::IN_TRACK) q.value = 2e-8;
    if (q.id >= Param::ECOM2_D0) q.value = 1e-9 * (1 + int(q.id) % 3);
  }
  Integration integ;
  std::vector<UtcEpoch> epochs;
  for (double t = 0; t <= span_h * 3600 + 1e-9; t += step) epochs.push_back(add_seconds(truth.epoch, t));
  std::vector<std::array<double, 6>> states;
  std::string error;
  auto t0 = std::chrono::steady_clock::now();
  if (!predict(truth, env, integ, epochs, &states, &error)) {
    std::printf("generate failed: %s\n", error.c_str());
    return 1;
  }
  auto t1 = std::chrono::steady_clock::now();
  std::printf("generated %zu points in %.2f s\n", epochs.size(), std::chrono::duration<double>(t1 - t0).count());

  const std::size_t half = epochs.size() / 2;
  if (std::getenv("SELF_CHECK")) {
    // Pure integration consistency: the truth sampled at the second half only.
    std::vector<UtcEpoch> sec(epochs.begin() + half, epochs.end());
    std::vector<std::array<double, 6>> st(states.begin() + half, states.end()), again;
    Integration other = integ;
    if (std::getenv("MAXSTEP")) other.maximum_step_s = std::atof(std::getenv("MAXSTEP"));
    if (std::getenv("RELTOL")) other.relative_tolerance = std::atof(std::getenv("RELTOL"));
    if (!predict(truth, env, other, sec, &again, &error)) return 1;
    ResidualStats c = residual_stats(sec, st, again, {}, true);
    std::printf("self: rms3d %.3f mm max %.3f mm T %.3f mm\n", c.rms_3d_km * 1e6, c.max_3d_km * 1e6, c.rms_t_km * 1e6);
    return 0;
  }
  std::vector<Point> first;
  for (std::size_t i = 0; i < half; ++i) {
    Point q;
    q.t = epochs[i];
    for (int k = 0; k < 3; ++k) q.r[k] = states[i][k], q.v[k] = states[i][3 + k];
    first.push_back(q);
  }
  Solution guess = truth;
  guess.state[0] += 120;
  guess.state[1] -= 80;
  guess.state[4] += 0.05;
  for (auto& q : guess.params) q.value = (q.id == Param::IN_TRACK || q.id >= Param::ECOM2_D0) ? 0.0 : 0.01;
  FitOptions opt;
  opt.maximum_fit_points = max_points;
  FitResult fr = fit(first, guess, env, integ, opt);
  auto t2 = std::chrono::steady_clock::now();
  if (!fr.ok) {
    std::printf("fit failed: %s\n", fr.error.c_str());
    return 1;
  }
  std::printf("fit: %d iterations, converged %d, wrms %.3e, %zu propagations, %zu points, %.2f s\n", fr.iterations,
              fr.converged, fr.weighted_rms, fr.propagations, fr.fit_points, std::chrono::duration<double>(t2 - t1).count());
  for (std::size_t j = 0; j < fr.solution.params.size(); ++j)
    std::printf("  %s = %.9e (truth %.9e)\n", param_name(fr.solution.params[j].id), fr.solution.params[j].value,
                truth.params[j].value);
  std::vector<UtcEpoch> second(epochs.begin() + half, epochs.end());
  std::vector<std::array<double, 6>> second_truth(states.begin() + half, states.end()), pred;
  if (!predict(fr.solution, env, integ, second, &pred, &error)) {
    std::printf("predict failed: %s\n", error.c_str());
    return 1;
  }
  ResidualStats c = residual_stats(second, second_truth, pred, {}, true);
  std::printf("closure: n %zu span %.0f s rms3d %.3f mm max %.3f mm R %.3f T %.3f N %.3f mm\n", c.n, c.span_s,
              c.rms_3d_km * 1e6, c.max_3d_km * 1e6, c.rms_r_km * 1e6, c.rms_t_km * 1e6, c.rms_n_km * 1e6);
  return c.max_3d_km <= 1e-5 ? 0 : 3;
}
