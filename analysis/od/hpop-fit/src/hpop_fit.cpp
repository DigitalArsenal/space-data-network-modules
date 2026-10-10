#include "hpop_fit.hpp"

#include <algorithm>
#include <cmath>
#include <memory>

// macOS <math.h> defines SING, an SDS LCC enumerator.
#ifdef SING
#undef SING
#endif
#include "PRW_generated.h"
#include "hpop/prw_execution.h"
#include "estimation.hpp"

namespace odhpop {

namespace est = sdn::estimation;

const char* param_name(Param p) {
  static const char* names[] = {"B",         "BDOT",       "AGOM",       "IN_TRACK",
                                "ECOM2_D0",  "ECOM2_Y0",   "ECOM2_B0",   "ECOM2_D2_COS",
                                "ECOM2_D2_SIN", "ECOM2_D4_COS", "ECOM2_D4_SIN", "ECOM2_B1_COS",
                                "ECOM2_B1_SIN", "ECOM2_B3_COS", "ECOM2_B3_SIN"};
  const auto i = static_cast<std::size_t>(p);
  return i < sizeof(names) / sizeof(names[0]) ? names[i] : "UNKNOWN";
}

namespace {

prwDynamicParameter prw_parameter(Param p) {
  switch (p) {
    case Param::B: return prwDynamicParameter::DRAG_AREA_OVER_MASS;
    case Param::BDOT: return prwDynamicParameter::DRAG_AREA_OVER_MASS_RATE;
    case Param::AGOM: return prwDynamicParameter::SRP_AREA_OVER_MASS;
    case Param::IN_TRACK: return prwDynamicParameter::IN_TRACK_ACCELERATION;
    default:
      return prwDynamicParameter(static_cast<int>(prwDynamicParameter::ECOM2_D0) +
                                 static_cast<int>(p) - static_cast<int>(Param::ECOM2_D0));
  }
}

double ecom2_value(const std::vector<ParamValue>& params, Param p) {
  for (const auto& q : params)
    if (q.id == p) return q.value;
  return 0.0;
}

bool has_param(const std::vector<ParamValue>& params, Param p) {
  for (const auto& q : params)
    if (q.id == p) return true;
  return false;
}

std::unique_ptr<TIMInstantT> utc_instant(const UtcEpoch& t) {
  auto i = std::make_unique<TIMInstantT>();
  i->TIME_SYSTEM = timingStandard::UTC;
  i->EPOCH_FORMAT = timEpochRepresentation::ISO8601;
  i->ISO8601 = format_iso_utc(t, 9);
  return i;
}

std::unique_ptr<FRMVector3T> vec3(double x, double y, double z) {
  auto v = std::make_unique<FRMVector3T>();
  v->X = x;
  v->Y = y;
  v->Z = z;
  return v;
}

// One PRW execution request: seed `state` (m, m/s, GCRF) at `epoch` with the
// solution's forces and parameter values, sampled at `epochs`.
std::vector<uint8_t> build_request(const Solution& s, const std::array<double, 6>& state,
                                   const std::vector<double>& values, const Integration& in,
                                   const std::vector<UtcEpoch>& epochs, bool with_sensitivity,
                                   bool has_eop, bool has_kernel) {
  const ForceModel& f = s.forces;
  auto exec = std::make_unique<PRWExecutionRequestT>();

  auto initial = std::make_unique<PRWResidentStateT>();
  auto sv = std::make_unique<FRMStateVectorT>();
  sv->REPRESENTATION = frmStateRepresentation::CARTESIAN;
  sv->POSITION = vec3(state[0], state[1], state[2]);
  sv->VELOCITY = vec3(state[3], state[4], state[5]);
  sv->COORDINATE_SYSTEM_NAME = "GCRF";
  sv->EPOCH = format_iso_utc(s.epoch, 9);
  sv->EPOCH_TIME_SYSTEM = "UTC";
  initial->STATE = std::move(sv);
  auto cs = std::make_unique<RFMCoordinateSystemT>();
  cs->NAME = "GCRF";
  cs->AXIS_TYPE = rfmAxisType::ICRF;
  cs->AXIS_REFERENCE_BODY_ID = 399;
  auto origin = std::make_unique<RFMOriginT>();
  origin->KIND = rfmOriginKind::CELESTIAL_BODY;
  origin->CELESTIAL_BODY_ID = 399;
  cs->ORIGIN = std::move(origin);
  initial->COORDINATE_SYSTEM = std::move(cs);
  exec->INITIAL = std::move(initial);

  auto integ = std::make_unique<PRWIntegratorSettingsT>();
  integ->ALGORITHM = prwSolverAlgorithm::RK78;
  integ->INITIAL_STEP_SECONDS = in.initial_step_s;
  integ->MINIMUM_STEP_SECONDS = in.minimum_step_s;
  integ->MAXIMUM_STEP_SECONDS = in.maximum_step_s > 0 ? in.maximum_step_s : auto_maximum_step(s.state, f.degree);
  integ->ABSOLUTE_TOLERANCES.assign(6, in.absolute_tolerance_m);
  integ->RELATIVE_TOLERANCE = in.relative_tolerance;
  integ->MAXIMUM_STEPS = in.maximum_steps;
  exec->INTEGRATOR = std::move(integ);

  // Parameter values: B and AGOM through Cd and Cr on a 1 m^2 area.
  auto value_of = [&](Param p, double fallback) {
    for (std::size_t i = 0; i < s.params.size(); ++i)
      if (s.params[i].id == p) return values[i];
    return fallback;
  };
  const double mass = f.srp_model == SrpModel::GNSS_BOX_WING ? f.box_wing_mass_kg : 1.0;
  auto forces = std::make_unique<PRWForceConfigurationT>();
  forces->GRAVITY_CHOICE = prwGravitySelection::EGM2008;
  forces->ENABLE_POINT_MASS = true;
  forces->GRAVITATIONAL_PARAMETER = f.gm;
  forces->ENABLE_J2 = false;
  forces->MAXIMUM_DEGREE = static_cast<uint16_t>(f.degree);
  forces->HAS_MAXIMUM_DEGREE = true;
  forces->MAXIMUM_ORDER = static_cast<uint16_t>(f.order);
  forces->HAS_MAXIMUM_ORDER = true;
  forces->ENABLE_THIRD_BODY = f.sun || f.moon || f.venus || f.mars || f.jupiter;
  if (f.sun) forces->THIRD_BODY_IDS.push_back(10);
  if (f.moon) forces->THIRD_BODY_IDS.push_back(301);
  if (f.venus) forces->THIRD_BODY_IDS.push_back(2);
  if (f.mars) forces->THIRD_BODY_IDS.push_back(4);
  if (f.jupiter) forces->THIRD_BODY_IDS.push_back(5);
  forces->INITIAL_MASS_KG = mass;
  forces->AREA_M2 = 1.0;
  forces->ENABLE_DRAG = f.drag;
  forces->DRAG_COEFFICIENT = value_of(Param::B, 0.0) * mass;
  forces->ATMOSPHERE_MODEL =
      f.atmosphere == Atmosphere::JB2008 ? prwAtmosphereFamily::JB2008 : prwAtmosphereFamily::NRLMSISE00;
  if (has_param(s.params, Param::BDOT) && f.drag) {
    forces->HAS_DRAG_AREA_OVER_MASS_RATE_M2_KG_S = true;
    forces->DRAG_AREA_OVER_MASS_RATE_M2_KG_S = value_of(Param::BDOT, 0.0);
  }
  forces->ENABLE_SRP = f.srp;
  forces->REFLECTIVITY_COEFFICIENT = f.srp_model == SrpModel::CANNONBALL ? value_of(Param::AGOM, 0.0) * mass : 0.0;
  if (f.srp_model == SrpModel::GNSS_BOX_WING) {
    forces->RADIATION_PRESSURE_MODEL = prwRadiationPressureFamily::GNSS_BOX_WING;
    forces->GNSS_BLOCK = f.gnss_block == GnssBlock::GPS_IIR     ? prwGnssSpacecraftBlock::GPS_IIR
                         : f.gnss_block == GnssBlock::GPS_IIR_M ? prwGnssSpacecraftBlock::GPS_IIR_M
                                                                : prwGnssSpacecraftBlock::GPS_IIF;
  }
  if (f.srp && f.ecom2) {
    auto e = std::make_unique<PRWEcom2T>();
    auto ev = [&](Param p) {
      for (std::size_t i = 0; i < s.params.size(); ++i)
        if (s.params[i].id == p) return values[i];
      return ecom2_value(s.params, p);
    };
    e->D0_M_S2 = ev(Param::ECOM2_D0);
    e->Y0_M_S2 = ev(Param::ECOM2_Y0);
    e->B0_M_S2 = ev(Param::ECOM2_B0);
    e->D2_COS_M_S2 = ev(Param::ECOM2_D2C);
    e->D2_SIN_M_S2 = ev(Param::ECOM2_D2S);
    e->D4_COS_M_S2 = ev(Param::ECOM2_D4C);
    e->D4_SIN_M_S2 = ev(Param::ECOM2_D4S);
    e->B1_COS_M_S2 = ev(Param::ECOM2_B1C);
    e->B1_SIN_M_S2 = ev(Param::ECOM2_B1S);
    e->B3_COS_M_S2 = ev(Param::ECOM2_B3C);
    e->B3_SIN_M_S2 = ev(Param::ECOM2_B3S);
    forces->ECOM2 = std::move(e);
  }
  if (has_param(s.params, Param::IN_TRACK)) {
    forces->HAS_IN_TRACK_ACCELERATION_M_S2 = true;
    forces->IN_TRACK_ACCELERATION_M_S2 = value_of(Param::IN_TRACK, 0.0);
  }
  forces->EPHEMERIS_SOURCE = has_kernel ? "JPL_SPK" : "Analytical";
  if (has_eop) {
    if (f.solid_tides) forces->SOLID_TIDES = prwSolidTideModel::IERS_2010;
    if (f.ocean_tide_degree >= 2) {
      forces->OCEAN_TIDES = prwOceanTideModel::FES2004;
      forces->OCEAN_TIDE_MAXIMUM_DEGREE = static_cast<uint16_t>(f.ocean_tide_degree);
      forces->OCEAN_TIDE_MAXIMUM_ORDER = static_cast<uint16_t>(f.ocean_tide_degree);
    }
  }
  if (f.relativity) forces->RELATIVITY = prwRelativityTerms::IERS_2010;
  if (f.earth_radiation && f.srp) {
    forces->EARTH_RADIATION = prwEarthRadiationModel::KNOCKE;
    forces->EARTH_RADIATION_RESOLUTION_DEG = f.earth_radiation_resolution_deg;
    if (f.srp_model != SrpModel::CANNONBALL) {
      forces->HAS_EARTH_RADIATION_AREA_OVER_MASS_M2_KG = true;
      forces->EARTH_RADIATION_AREA_OVER_MASS_M2_KG = value_of(Param::AGOM, 0.0);
    }
  }
  exec->FORCES = std::move(forces);

  for (const auto& e : epochs) exec->SAMPLE_EPOCHS.push_back(utc_instant(e));
  // The target is the latest sample (or the epoch itself).
  UtcEpoch last = s.epoch;
  double latest = 0.0;
  for (const auto& e : epochs) {
    const double dt = seconds_between(s.epoch, e);
    if (dt > latest) {
      latest = dt;
      last = e;
    }
  }
  exec->TARGET_EPOCH = utc_instant(last);
  exec->STM_TECHNIQUE = prwDerivativeTechnique::ANALYTIC;
  exec->DENSITY_TREATMENT = f.drag ? prwDensityTreatment::FINITE_DIFFERENCE : prwDensityTreatment::NEGLECTED;
  if (with_sensitivity) {
    exec->INCLUDE_STM = true;
    for (const auto& p : s.params) exec->DYNAMIC_PARAMETERS.push_back(prw_parameter(p.id));
  }

  PRWT root;
  root.EXECUTION_REQUEST = std::move(exec);
  flatbuffers::FlatBufferBuilder fbb(4096);
  FinishSizePrefixedPRWBuffer(fbb, PRW::Pack(fbb, &root));
  return std::vector<uint8_t>(fbb.GetBufferPointer(), fbb.GetBufferPointer() + fbb.GetSize());
}

struct Sample {
  std::array<double, 6> state{};
  std::vector<double> stm;  // n x n, n = 6 + p
  unsigned n = 0;
};

bool run(const std::vector<uint8_t>& request, const Environment& env, std::vector<Sample>* samples,
         std::string* error) {
  hpop::PrwEnvironment e;
  e.earthOrientation = env.earth_orientation;
  e.earthOrientationSize = env.earth_orientation_size;
  e.spaceWeather = env.space_weather;
  e.spaceWeatherSize = env.space_weather_size;
  e.jb2008Indices = env.jb2008_indices;
  e.jb2008IndicesSize = env.jb2008_indices_size;
  std::vector<uint8_t> out;
  std::string err;
  if (!hpop::processPrwInvoke(request.data(), request.size(), env.kernel, env.kernel_size, e, out, err)) {
    *error = err;
    return false;
  }
  flatbuffers::Verifier verifier(out.data(), out.size());
  if (!VerifySizePrefixedPRWBuffer(verifier)) {
    *error = "hpop-response: not a size-prefixed $PRW record";
    return false;
  }
  const PRW* root = GetSizePrefixedPRW(out.data());
  const auto* result = root->EXECUTION_RESULT();
  if (!result || !result->SAMPLES()) {
    *error = "hpop-response: no samples";
    return false;
  }
  samples->clear();
  for (const auto* s : *result->SAMPLES()) {
    Sample x;
    const auto* st = s->STATE() ? s->STATE()->STATE() : nullptr;
    if (!st || !st->POSITION() || !st->VELOCITY()) {
      *error = "hpop-response: sample without state";
      return false;
    }
    x.state = {st->POSITION()->X(), st->POSITION()->Y(), st->POSITION()->Z(),
               st->VELOCITY()->X(), st->VELOCITY()->Y(), st->VELOCITY()->Z()};
    if (s->STM() && s->STM()->VALUES()) {
      x.n = s->STM()->DIMENSION();
      x.stm.assign(s->STM()->VALUES()->begin(), s->STM()->VALUES()->end());
    }
    samples->push_back(std::move(x));
  }
  return true;
}

// The space-weather drivers step at UTC boundaries (NRLMSISE-00's daily
// F10.7 and Ap, the 3-hourly Kp): a step that straddles one integrates a
// different density. With drag on, every 3-hour UTC boundary inside the arc
// becomes an extra sample epoch, so the integration restarts exactly there
// (E4-A5 2026-10-10: 2 mm jump after midnight, then 0.6 mm/h, without it).
std::vector<UtcEpoch> breakpoints(const UtcEpoch& seed, const std::vector<UtcEpoch>& epochs) {
  std::vector<UtcEpoch> out;
  double lo = 0, hi = 0;
  for (const auto& e : epochs) {
    const double dt = seconds_between(seed, e);
    lo = std::min(lo, dt);
    hi = std::max(hi, dt);
  }
  // 3-hour boundaries from the seed's 00:00 UTC (jd2 is the day fraction).
  const double since = seed.jd2 * 86400.0;
  const double first = std::ceil((since + lo) / 10800.0) * 10800.0 - since;
  for (double dt = first; dt < hi; dt += 10800.0)
    if (dt > lo && std::abs(dt) > 1e-6) out.push_back(add_seconds(seed, dt));
  return out;
}

// HPOP samples of one seed at `epochs` (plus the drag breakpoints, dropped
// from the answer), at most 10000 per request.
bool sample(const Solution& s, const std::array<double, 6>& state, const std::vector<double>& values,
            const Integration& integration, const std::vector<UtcEpoch>& epochs, bool with_sensitivity,
            const Environment& env, std::vector<Sample>* out, std::string* error) {
  std::vector<UtcEpoch> all = epochs;
  if (s.forces.drag) {
    for (const auto& b : breakpoints(s.epoch, epochs)) {
      bool present = false;
      for (const auto& e : epochs)
        if (std::abs(seconds_between(b, e)) < 1e-6) present = true;
      if (!present) all.push_back(b);
    }
  }
  out->clear();
  out->reserve(epochs.size());
  std::vector<Sample> got;
  // In time order; chunks restart from the seed with their own breakpoints.
  std::vector<std::size_t> order(all.size());
  for (std::size_t i = 0; i < order.size(); ++i) order[i] = i;
  std::vector<double> offset(all.size());
  for (std::size_t i = 0; i < all.size(); ++i) offset[i] = seconds_between(s.epoch, all[i]);
  std::stable_sort(order.begin(), order.end(), [&](std::size_t a, std::size_t b) { return offset[a] < offset[b]; });
  std::vector<Sample> answers(all.size());
  for (std::size_t at = 0; at < order.size(); at += 10000) {
    const std::size_t end = std::min(order.size(), at + 10000);
    std::vector<UtcEpoch> chunk;
    for (std::size_t k = at; k < end; ++k) chunk.push_back(all[order[k]]);
    if (!run(build_request(s, state, values, integration, chunk, with_sensitivity,
                           env.earth_orientation_size > 0, env.kernel_size > 0),
             env, &got, error))
      return false;
    if (got.size() != chunk.size()) {
      *error = "hpop-response: sample count";
      return false;
    }
    for (std::size_t k = at; k < end; ++k) answers[order[k]] = std::move(got[k - at]);
  }
  for (std::size_t i = 0; i < epochs.size(); ++i) out->push_back(std::move(answers[i]));
  return true;
}

}  // namespace

bool predict(const Solution& solution, const Environment& env, const Integration& integration,
             const std::vector<UtcEpoch>& epochs, std::vector<std::array<double, 6>>* states,
             std::string* error) {
  std::vector<double> values;
  for (const auto& p : solution.params) values.push_back(p.value);
  std::vector<Sample> got;
  if (!sample(solution, solution.state, values, integration, epochs, false, env, &got, error)) return false;
  states->clear();
  for (const auto& g : got) states->push_back(g.state);
  return true;
}

FitResult fit(const std::vector<Point>& points, const Solution& initial, const Environment& env,
              const Integration& integration, const FitOptions& options) {
  FitResult out;
  out.solution = initial;
  if (points.size() < 4) {
    out.error = "fit-failed: fewer than four points";
    return out;
  }
  // Evenly spaced fit points by index, always keeping both ends.
  std::vector<std::size_t> pick;
  const std::size_t m = std::min(points.size(), std::max<std::size_t>(options.maximum_fit_points, 4));
  for (std::size_t k = 0; k < m; ++k) {
    const std::size_t i = m == 1 ? 0 : static_cast<std::size_t>(std::llround(double(k) * double(points.size() - 1) / double(m - 1)));
    if (pick.empty() || pick.back() != i) pick.push_back(i);
  }
  std::vector<est::Observation> observations;
  std::vector<UtcEpoch> epochs;
  for (std::size_t i : pick) {
    est::Observation o;
    o.epoch_seconds = seconds_between(initial.epoch, points[i].t);
    o.kind = est::MeasurementKind::POSITION_VECTOR;
    o.value_count = 3;
    o.value = {points[i].r[0], points[i].r[1], points[i].r[2], 0, 0, 0};
    o.sigma = {options.sigma_m, options.sigma_m, options.sigma_m, 1, 1, 1};
    o.apply_light_time = false;
    o.apply_sagnac = false;
    observations.push_back(o);
    epochs.push_back(points[i].t);
  }
  out.fit_points = observations.size();

  const std::size_t p = initial.params.size();
  est::BatchFitConfig config;
  for (int i = 0; i < 6; ++i) config.initial_state[i] = initial.state[i];
  for (const auto& q : initial.params) {
    config.initial_parameters.push_back(q.value);
    config.lower_bounds.push_back(q.lower);
    config.upper_bounds.push_back(q.upper);
  }
  config.maximum_iterations = options.maximum_iterations;
  config.correction_tolerance = options.correction_tolerance;
  config.levenberg_marquardt = options.levenberg_marquardt;
  config.rtn_output = true;
  std::string error;
  std::size_t propagations = 0;
  config.propagator = [&](const est::Vector6& seed, const std::vector<double>& parameters,
                          const std::vector<est::EpochRequest>& requests,
                          std::vector<est::ParameterSample>* samples) -> bool {
    std::vector<UtcEpoch> at;
    at.reserve(requests.size());
    for (const auto& r : requests) at.push_back(add_seconds(epochs[r.observation], r.shift_seconds));
    std::array<double, 6> state{};
    for (int i = 0; i < 6; ++i) state[i] = seed[i];
    std::vector<Sample> got;
    ++propagations;
    if (!sample(initial, state, parameters, integration, at, true, env, &got, &error)) return false;
    if (got.size() != requests.size()) {
      error = "hpop-response: sample count";
      return false;
    }
    samples->clear();
    for (const auto& g : got) {
      est::ParameterSample s;
      for (int i = 0; i < 6; ++i) s.state.value[i] = g.state[i];
      const unsigned n = g.n;
      if (n != 6 + p || g.stm.size() != std::size_t(n) * n) {
        error = "hpop-response: STM dimension";
        return false;
      }
      for (int i = 0; i < 6; ++i)
        for (int j = 0; j < 6; ++j) s.stm[i * 6 + j] = g.stm[i * n + j];
      s.sensitivity.assign(6 * p, 0.0);
      for (int i = 0; i < 6; ++i)
        for (std::size_t j = 0; j < p; ++j) s.sensitivity[i * p + j] = g.stm[i * n + 6 + j];
      samples->push_back(std::move(s));
    }
    return true;
  };
  const est::BatchFitResult r = est::batch_fit(config, observations);
  out.propagations = propagations;
  if (!r.valid) {
    out.error = !error.empty() ? error : ("fit-failed: " + r.error);
    return out;
  }
  for (int i = 0; i < 6; ++i) out.solution.state[i] = r.estimate[i];
  for (std::size_t j = 0; j < p; ++j) out.solution.params[j].value = r.estimate[6 + j];
  out.covariance = r.covariance;
  out.scaled_covariance = r.scaled_covariance;
  out.covariance_rtn = r.covariance_rtn;
  out.bound_status = r.bound_status;
  out.iterations = r.iterations;
  out.converged = r.converged;
  out.weighted_rms = r.weighted_rms;
  out.chi_square = r.chi_square;
  out.reduced_chi_square = r.reduced_chi_square;
  out.ok = true;
  return out;
}

double auto_maximum_step(const std::array<double, 6>& x, int degree) {
  const double mu = 3.986004415e14;
  const double r = std::sqrt(x[0] * x[0] + x[1] * x[1] + x[2] * x[2]);
  const double v2 = x[3] * x[3] + x[4] * x[4] + x[5] * x[5];
  const double a = 1.0 / (2.0 / r - v2 / mu);
  const double hx = x[1] * x[5] - x[2] * x[4], hy = x[2] * x[3] - x[0] * x[5], hz = x[0] * x[4] - x[1] * x[3];
  const double h = std::sqrt(hx * hx + hy * hy + hz * hz);
  const double e = std::sqrt(std::max(0.0, 1.0 - h * h / (mu * a)));
  const double rp = a > 0 ? a * (1.0 - e) : r;
  const double vp = h / rp;  // perigee speed
  const double step = 2.0 * M_PI * (rp / vp) / (3.0 * std::max(2, degree));
  return std::clamp(step, 1.0, 300.0);
}

std::vector<ParamValue> default_parameters(const std::array<double, 6>& x, double span_s,
                                           ForceModel* forces) {
  const double mu = 3.986004415e14;
  const double r = std::sqrt(x[0] * x[0] + x[1] * x[1] + x[2] * x[2]);
  const double v2 = x[3] * x[3] + x[4] * x[4] + x[5] * x[5];
  const double a = 1.0 / (2.0 / r - v2 / mu);
  const double hx = x[1] * x[5] - x[2] * x[4], hy = x[2] * x[3] - x[0] * x[5], hz = x[0] * x[4] - x[1] * x[3];
  const double h2 = hx * hx + hy * hy + hz * hz;
  const double e = std::sqrt(std::max(0.0, 1.0 - h2 / (mu * a)));
  const double perigee_km = (a * (1.0 - e) - 6378137.0) / 1000.0;
  std::vector<ParamValue> out;
  const double nan = std::numeric_limits<double>::quiet_NaN();
  const bool cannonball = forces->srp && forces->srp_model == SrpModel::CANNONBALL;
  if (perigee_km < 2500.0) {  // propagator/hpop applies drag below 2500 km
    forces->ecom2 = false;
    if (forces->drag) out.push_back({Param::B, 0.01, 0.0, nan});
    if (cannonball) out.push_back({Param::AGOM, 0.01, 0.0, nan});
    out.push_back({Param::IN_TRACK, 0.0, nan, nan});
    return out;
  }
  if (!forces->srp) return out;
  forces->ecom2 = true;
  // Cannonball AGOM and ECOM2 D0 both act along the Sun direction under the
  // same shadow function: estimating both is near-singular, so D0 is
  // estimated only over a box-wing a priori (which has no AGOM).
  if (cannonball) out.push_back({Param::AGOM, 0.01, 0.0, nan});
  else out.push_back({Param::ECOM2_D0, 0.0, nan, nan});
  out.push_back({Param::ECOM2_Y0, 0.0, nan, nan});
  out.push_back({Param::ECOM2_B0, 0.0, nan, nan});
  if (span_s >= 86400.0)
    for (int k = static_cast<int>(Param::ECOM2_D2C); k <= static_cast<int>(Param::ECOM2_B3S); ++k)
      out.push_back({static_cast<Param>(k), 0.0, nan, nan});
  return out;
}

}  // namespace odhpop
