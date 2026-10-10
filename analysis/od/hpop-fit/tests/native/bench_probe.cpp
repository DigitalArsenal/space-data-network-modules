// Native development probe (not a test): the cost of one HPOP propagation
// over a Starlink-like 3.2 h arc (193 samples at 60 s) by force model, with and
// without the variational equations.
#include <chrono>
#include <cmath>
#include <cstdio>
#include <fstream>
#include <iterator>
#include <string>
#include "../../src/hpop_fit.hpp"
using namespace odhpop;
static std::vector<uint8_t> slurp(const std::string& p) { std::ifstream f(p, std::ios::binary); return {std::istreambuf_iterator<char>(f), {}}; }
int main(int, char** argv) {
  const std::string dir = argv[1];
  auto eop = slurp(dir + "/earth_orientation.prw"), sw = slurp(dir + "/space_weather.prw"), kernel = slurp(dir + "/kernel.prw");
  Environment env;
  env.earth_orientation = eop.data(), env.earth_orientation_size = eop.size();
  env.space_weather = sw.data(), env.space_weather_size = sw.size();
  env.kernel = kernel.data(), env.kernel_size = kernel.size();
  Solution s;
  s.epoch = utc_from_calendar(2026, 7, 2, 3, 0, 0.0);
  const double mu = 3.986004415e14, a = 6378137.0 + 550e3, inc = 53.05 * M_PI / 180, v = std::sqrt(mu / a);
  s.state = {a, 0, 0, 0, v * std::cos(inc), v * std::sin(inc)};
  s.params = default_parameters(s.state, 11520, &s.forces);
  for (auto& q : s.params) q.value = q.id == Param::IN_TRACK ? 0 : 0.01;
  std::vector<UtcEpoch> t;
  for (double x = 0; x <= 11520; x += 60) t.push_back(add_seconds(s.epoch, x));
  std::vector<Point> pts;
  {
    std::vector<std::array<double, 6>> st;
    std::string e;
    predict(s, env, Integration(), t, &st, &e);
    for (std::size_t i = 0; i < t.size(); ++i) { Point p; p.t = t[i]; for (int k = 0; k < 3; ++k) p.r[k] = st[i][k], p.v[k] = st[i][3 + k]; pts.push_back(p); }
  }
  struct M { const char* name; ForceModel f; };
  ForceModel full = s.forces;
  auto with = [&](auto edit) { ForceModel f = full; edit(f); return f; };
  M models[] = {{"full", full},
                {"no knocke", with([](ForceModel& f) { f.earth_radiation = false; })},
                {"no ocean tides", with([](ForceModel& f) { f.ocean_tide_degree = 0; })},
                {"degree 20", with([](ForceModel& f) { f.degree = f.order = 20; })},
                {"no planets/rel", with([](ForceModel& f) { f.venus = f.mars = f.jupiter = false; f.relativity = false; })},
                {"reduced (stage 1)", reduced_forces(full, 20)}};
  for (auto& m : models) {
    Solution x = s;
    x.forces = m.f;
    std::vector<std::array<double, 6>> st;
    std::string e;
    auto t0 = std::chrono::steady_clock::now();
    predict(x, env, Integration(), t, &st, &e);
    auto t1 = std::chrono::steady_clock::now();
    FitOptions o;
    o.staged = false;
    o.maximum_iterations = 1;
    fit(pts, x, env, Integration(), o);
    auto t2 = std::chrono::steady_clock::now();
    std::printf("%-20s predict %.3f s   one fit round (STM + %zu params) %.3f s %s\n", m.name,
                std::chrono::duration<double>(t1 - t0).count(), x.params.size(), std::chrono::duration<double>(t2 - t1).count(), e.c_str());
  }
}
