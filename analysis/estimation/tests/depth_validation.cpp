#include "estimation.hpp"
#include "two_body_provider.hpp"
#include <cassert>
#include <cmath>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <sstream>
using namespace sdn::estimation;
namespace {
FilterConfig prior() {
  FilterConfig c;
  for (int i = 0; i < 6; ++i)
    c.initial_covariance[7 * i] = 1;
  c.sigma_edit_threshold = 1e9;
  return c;
}
Observation pv(double t) {
  Observation o;
  o.kind = MeasurementKind::POSITION_VELOCITY;
  o.epoch_seconds = t;
  o.value_count = 6;
  o.apply_light_time = o.apply_sagnac = false;
  return o;
}
PropagatorSample identity(double t = 0) {
  PropagatorSample p;
  p.state.epoch_seconds = t;
  p.stm = identity6();
  return p;
}
void nonlinear_moments() {
  for (double alpha : {1., .5}) {
    auto c = prior();
    c.initial.value[0] = 2;
    c.initial_covariance[0] = .25;
    c.estimator = EstimatorKind::UNSCENTED_KALMAN_FILTER;
    c.ukf_alpha = alpha;
    c.ukf_beta = 2;
    c.ukf_kappa = 0;
    int calls = 0;
    std::vector<CartesianState> seeds;
    c.propagator = [&](const CartesianState &seed, double t,
                       PropagatorSample *s) {
      ++calls;
      seeds.push_back(seed);
      s->state = seed;
      s->state.epoch_seconds = t;
      s->state.value[0] = seed.value[0] * seed.value[0];
      s->stm = identity6();
      s->stm[0] = 2 * seed.value[0];
      return true;
    };
    auto o = pv(1);
    o.value[0] = 4;
    o.sigma.fill(100);
    auto o2 = o;
    o2.epoch_seconds = 2;
    auto f = sequential_filter(c, {o, o2}, {}, true);
    assert(f.valid && calls == 26);
    const double expected_mean = 4.25;
    const double expected_variance = 4 + (alpha * alpha * 5 + 2) * .0625;
    double e = std::max(
        std::abs(f.epochs[0].predicted.value[0] - expected_mean),
        std::abs(f.epochs[0].predicted_covariance[0] - expected_variance));
    assert(e < 2e-14);
    assert(seeds[13].value ==
           f.epochs[0].filtered.value); // actual nonlinear recenter
    c.estimator = EstimatorKind::EXTENDED_KALMAN_FILTER;
    calls = 0;
    auto ekf = sequential_filter(c, {o, o2}, {}, false);
    assert(ekf.valid && calls == 2);
    assert(ekf.epochs[0].predicted.value[0] == 4 &&
           std::abs(ekf.epochs[0].predicted_covariance[0] - 4) < 1e-14);
    std::cout << "PASS Wan-Merwe quadratic transform alpha=" << alpha
              << " error=" << e << " recentered_calls=26\n";
  }
}
void linear_pv_clock() {
  for (auto kind : {EstimatorKind::LINEAR_KALMAN_FILTER,
                    EstimatorKind::EXTENDED_KALMAN_FILTER,
                    EstimatorKind::UNSCENTED_KALMAN_FILTER}) {
    auto c = prior();
    c.estimator = kind;
    auto o = pv(0);
    o.value = {2, 4, 6, 8, 10, 12};
    auto f = sequential_filter(c, {o}, {identity()}, true);
    assert(f.valid);
    for (int i = 0; i < 6; ++i) {
      assert(std::abs(f.epochs[0].filtered.value[i] - o.value[i] / 2) < 1e-14);
      assert(std::abs(f.epochs[0].filtered_covariance[7 * i] - .5) < 1e-14);
    }
  }
  auto c = prior();
  c.estimate_clock = true;
  c.estimator = EstimatorKind::LINEAR_KALMAN_FILTER;
  for (int i = 0; i < 8; ++i)
    c.initial_covariance8[9 * i] = 1;
  auto o = pv(0);
  o.kind = MeasurementKind::LINEAR;
  o.value_count = 1;
  o.value[0] = 4;
  o.linear_matrix.assign(8, 0);
  o.linear_matrix[0] = o.linear_matrix[6] = 1;
  o.linear_offset = {0};
  auto f = sequential_filter(c, {o}, {identity()}, false);
  assert(f.valid);
  assert(std::abs(f.epochs[0].filtered_extended[0] - 4. / 3) < 1e-14);
  assert(std::abs(f.epochs[0].filtered_extended[6] - 4. / 3) < 1e-14);
  assert(std::abs(f.epochs[0].filtered_covariance_extended[6] + 1. / 3) <
         1e-14);
  // Pseudorange = receiver-satellite distance + receiver bias - satellite bias.
  c.estimator = EstimatorKind::EXTENDED_KALMAN_FILTER;
  c.initial_clock_bias_m = 100;
  c.initial_clock_drift_mps = 2;
  o.kind = MeasurementKind::PSEUDORANGE;
  o.epoch_seconds = 10;
  o.station_position_m = {-20000000, 0, 0};
  o.satellite_clock_bias_m = 7;
  o.value[0] = 20000113;
  auto s = identity(10);
  f = sequential_filter(c, {o}, {s}, true);
  assert(f.valid);
  assert(std::abs(f.epochs[0].filtered_extended[6] - 120) < 1e-12);
  assert(std::abs(f.epochs[0].filtered_extended[7] - 2) < 1e-12);
  assert(std::abs(f.epochs[0].filtered_covariance_extended[63] - 3. / 103) <
         1e-12);
  assert(f.epochs[0].normalized_innovation_squared == 0);
  std::cout << "PASS six-lane PV and eight-state clock Gaussian conditioning "
               "error<1e-12\n";
}
void adaptation() {
  auto c = prior();
  c.sigma_edit_threshold = 3;
  auto o = pv(0);
  o.value[0] = 10;
  auto f = sequential_filter(c, {o}, {identity()}, false);
  assert(f.valid && !f.epochs[0].accepted);
  c.inflate_measurement_noise = true;
  f = sequential_filter(c, {o}, {identity()}, false);
  assert(f.valid && f.epochs[0].accepted);
  const double scale = 100. / 9 - 1;
  assert(std::abs(f.epochs[0].measurement_noise_scale - scale) < 1e-10);
  c.maximum_measurement_scale = 2;
  f = sequential_filter(c, {o}, {identity()}, false);
  assert(f.valid && !f.epochs[0].accepted);
  c = prior();
  c.estimator = EstimatorKind::LINEAR_KALMAN_FILTER;
  c.process_noise = ProcessNoiseKind::STATE_NOISE_COMPENSATION;
  c.acceleration_psd = {3, 0, 0};
  c.adaptive_process_noise = true;
  c.adaptation_rate = .25;
  o = pv(1);
  o.kind = MeasurementKind::LINEAR;
  o.value_count = 1;
  o.value[0] = 3;
  o.linear_matrix = {1, 0, 0, 0, 0, 0};
  o.linear_offset = {0};
  auto o2 = o;
  o2.epoch_seconds = 2;
  auto s1 = identity(1), s2 = identity(2);
  s1.stm[3] = 1;
  s2.stm[3] = 2;
  f = sequential_filter(c, {o, o2}, {s1, s2}, false);
  assert(f.valid);
  // Pminus_xx=3, R=1, innovation^2=9, H Qbase H'=1:
  // qtarget=1+(9-4)/1=6; qnext=.75*1+.25*6=2.25.
  assert(std::abs(f.epochs[1].process_noise_scale - 2.25) < 1e-14);
  c.adaptive_process_noise = false;
  auto fixed = sequential_filter(c, {o, o2}, {s1, s2}, false);
  assert(fixed.valid && fixed.epochs[1].process_noise_scale == 1);
  assert(f.epochs[1].predicted_covariance[0] >
         fixed.epochs[1].predicted_covariance[0]);
  std::cout << "PASS Mehra scalar covariance matching qscale=2.25; sigma-gated "
               "R scale="
            << scale << " capped rejection; defaults off\n";
}
void orekit(const char *file) {
  std::ifstream stream(file);
  assert(stream);
  std::string line;
  for (int kind = 1; kind <= 2; ++kind) {
    std::vector<Observation> observations;
    std::vector<Vector6> xs;
    std::vector<Matrix6> ps;
    for (int i = 0; i < 10; ++i) {
      assert(std::getline(stream, line));
      std::istringstream row(line);
      int k;
      double t;
      row >> k >> t;
      assert(k == kind);
      auto o = pv(t);
      for (double &v : o.value)
        row >> v;
      o.sigma = {10, 10, 10, .01, .01, .01};
      Vector6 x{};
      Matrix6 p{};
      for (double &v : x)
        row >> v;
      for (double &v : p)
        row >> v;
      assert(row);
      observations.push_back(o);
      xs.push_back(x);
      ps.push_back(p);
    }
    auto c = prior();
    c.initial.value = {7000100, -80, 60, .1, 7499.92, 1000.05};
    for (int i = 0; i < 6; ++i)
      c.initial_covariance[7 * i] = i < 3 ? 10000 : .01;
    c.estimator = static_cast<EstimatorKind>(kind);
    c.propagator = test_provider::two_body;
    auto f = sequential_filter(c, observations, {}, true);
    assert(f.valid);
    double position = 0, velocity = 0, covariance = 0;
    for (int i = 0; i < 10; ++i) {
      for (int j = 0; j < 6; ++j) {
        double e = std::abs(f.epochs[i].filtered.value[j] - xs[i][j]);
        if (j < 3)
          position = std::max(position, e);
        else
          velocity = std::max(velocity, e);
      }
      for (int j = 0; j < 36; ++j)
        covariance =
            std::max(covariance,
                     std::abs(f.epochs[i].filtered_covariance[j] - ps[i][j]));
    }
    std::cout << "OREKIT kind=" << kind << " position_max_m=" << position
              << " velocity_max_mps=" << velocity
              << " covariance_max_SI=" << covariance << std::endl;
    assert(position < 1e-6 && velocity < 1e-8 && covariance < 1e-6);
  }
}
} // namespace
int main(int argc, char **argv) {
  assert(argc == 2);
  std::cout << std::setprecision(17);
  nonlinear_moments();
  linear_pv_clock();
  adaptation();
  orekit(argv[1]);
  std::cout << "PASS estimation depth failures=0\n";
}
