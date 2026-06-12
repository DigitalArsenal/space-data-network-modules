using namespace sdn_hypersonics;

// ---------------------------------------------------------------------------
// Reentry 3-DOF drag-lift entry integrator.
//
// Replaces the former kinematic corridor interpolator with a real RK4
// integrator:
//   state  = ECEF position (m), ECEF velocity (m/s); mass constant.
//   forces = inverse-square gravity, aerodynamic drag, aerodynamic lift
//            (L/D and bank angle from the request), and the rotating-frame
//            Coriolis/centrifugal terms.  Atmosphere through the shared
//            atmosphere_for_model() helper, plus an EXPONENTIAL analytic
//            model used by the Allen-Eggers validation benchmark.
//
// Default capsule aerodynamics:
//   - Hypersonic trim L/D = 0.18 at ~12 deg angle of attack for Crew Dragon:
//     "SpaceX Dragon Re-Entry Vehicle: Aerodynamics and Aerothermodynamics
//     with Application to Base Heat-Shield Design" (SpaceX/AIAA).
//   - Hypersonic capsule drag coefficient ~1.3: Apollo command module entry
//     aerodynamics, NASA TN "Entry Flight Aerodynamics from Apollo Mission
//     AS-202" (NTRS 19670027745) reports hypersonic trim CD near 1.25-1.35.
//   - Entry interface convention 121,920 m (400,000 ft), standard NASA
//     definition for crewed entries.
//   - Default terminal altitude 5,486 m (18,000 ft): Crew Dragon drogue
//     deployment altitude per the NASA Crew-8 return blog (see
//     reference-missions/crew-8/events.json in the launch-ascent module).
// ---------------------------------------------------------------------------

namespace {

constexpr double kPi = 3.141592653589793238462643383279502884;
constexpr double kEarthMeanRadiusM = 6371008.8;
constexpr double kEarthMuM3S2 = 3.986004418e14;
constexpr double kEarthRotationRadS = 7.292115e-5;
constexpr double kWgs84A = 6378137.0;
constexpr double kWgs84F = 1.0 / 298.257223563;
constexpr double kWgs84E2 = kWgs84F * (2.0 - kWgs84F);
// US76 is tabulated to 86 km; the shared helper clamps above that, which
// would impose a constant (unphysically large) density at orbital altitudes,
// so the integrator treats "US76" as vacuum above its 86 km validity ceiling.
// The honest exponential extension stays usable to 150 km, above which
// dynamic pressure is negligible on ascent/entry time scales.
constexpr double kUs76CeilingM = 86000.0;
constexpr double kAtmosphereCutoffM = 150000.0;
constexpr double kG0 = 9.80665;

struct Vec3 {
  double x = 0.0;
  double y = 0.0;
  double z = 0.0;
};

Vec3 operator+(const Vec3& a, const Vec3& b) { return {a.x + b.x, a.y + b.y, a.z + b.z}; }
Vec3 operator-(const Vec3& a, const Vec3& b) { return {a.x - b.x, a.y - b.y, a.z - b.z}; }
Vec3 operator*(const Vec3& a, double s) { return {a.x * s, a.y * s, a.z * s}; }
double dot(const Vec3& a, const Vec3& b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
Vec3 cross(const Vec3& a, const Vec3& b) {
  return {a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x};
}
double norm(const Vec3& a) { return std::sqrt(dot(a, a)); }
Vec3 normalized(const Vec3& a) {
  const double n = norm(a);
  return n > 0.0 ? a * (1.0 / n) : Vec3{0.0, 0.0, 1.0};
}

double deg_to_rad(double degrees) { return degrees * kPi / 180.0; }
double rad_to_deg(double radians) { return radians * 180.0 / kPi; }

double normalize_longitude_deg(double longitude) {
  double value = std::fmod(longitude + 540.0, 360.0);
  if (value < 0.0) {
    value += 360.0;
  }
  return value - 180.0;
}

double normalize_heading_deg(double heading) {
  double value = std::fmod(heading, 360.0);
  if (value < 0.0) {
    value += 360.0;
  }
  return value;
}

double heading_delta_deg(double left, double right) {
  const double delta = std::fabs(normalize_heading_deg(left) - normalize_heading_deg(right));
  return std::min(delta, 360.0 - delta);
}

Vec3 geodetic_to_ecef(double lat_deg, double lon_deg, double height_m) {
  const double lat = deg_to_rad(lat_deg);
  const double lon = deg_to_rad(lon_deg);
  const double sin_lat = std::sin(lat);
  const double cos_lat = std::cos(lat);
  const double n = kWgs84A / std::sqrt(1.0 - kWgs84E2 * sin_lat * sin_lat);
  return {
    (n + height_m) * cos_lat * std::cos(lon),
    (n + height_m) * cos_lat * std::sin(lon),
    (n * (1.0 - kWgs84E2) + height_m) * sin_lat,
  };
}

void ecef_to_geodetic(const Vec3& r, double* lat_deg, double* lon_deg, double* height_m) {
  const double p = std::hypot(r.x, r.y);
  const double lon = std::atan2(r.y, r.x);
  double lat = std::atan2(r.z, p * (1.0 - kWgs84E2));
  double h = 0.0;
  for (int i = 0; i < 5; ++i) {
    const double sin_lat = std::sin(lat);
    const double n = kWgs84A / std::sqrt(1.0 - kWgs84E2 * sin_lat * sin_lat);
    h = (p > 1.0) ? (p / std::cos(lat) - n) : (std::fabs(r.z) - n * (1.0 - kWgs84E2));
    lat = std::atan2(r.z, p * (1.0 - kWgs84E2 * n / (n + h)));
  }
  *lat_deg = rad_to_deg(lat);
  *lon_deg = normalize_longitude_deg(rad_to_deg(lon));
  *height_m = h;
}

void enu_basis(double lat_deg, double lon_deg, Vec3* east, Vec3* north, Vec3* up) {
  const double lat = deg_to_rad(lat_deg);
  const double lon = deg_to_rad(lon_deg);
  const double sin_lat = std::sin(lat);
  const double cos_lat = std::cos(lat);
  const double sin_lon = std::sin(lon);
  const double cos_lon = std::cos(lon);
  *east = {-sin_lon, cos_lon, 0.0};
  *north = {-sin_lat * cos_lon, -sin_lat * sin_lon, cos_lat};
  *up = {cos_lat * cos_lon, cos_lat * sin_lon, sin_lat};
}

bool number_array3(const std::string& json, const std::string& key, Vec3* out) {
  const size_t key_pos = json.find("\"" + key + "\"");
  if (key_pos == std::string::npos) {
    return false;
  }
  const size_t open = json.find('[', key_pos);
  if (open == std::string::npos) {
    return false;
  }
  const char* cursor = json.c_str() + open + 1;
  double values[3] = {0.0, 0.0, 0.0};
  for (int i = 0; i < 3; ++i) {
    char* end = nullptr;
    while (*cursor == ',' || *cursor == ' ' || *cursor == '\n' || *cursor == '\t' || *cursor == '\r') {
      ++cursor;
    }
    values[i] = std::strtod(cursor, &end);
    if (end == cursor) {
      return false;
    }
    cursor = end;
  }
  out->x = values[0];
  out->y = values[1];
  out->z = values[2];
  return true;
}

double heading_between_deg(
  double lat1_deg,
  double lon1_deg,
  double lat2_deg,
  double lon2_deg
) {
  const double lat1 = deg_to_rad(lat1_deg);
  const double lat2 = deg_to_rad(lat2_deg);
  const double dlon = deg_to_rad(lon2_deg - lon1_deg);
  const double y = std::sin(dlon) * std::cos(lat2);
  const double x =
    std::cos(lat1) * std::sin(lat2) -
    std::sin(lat1) * std::cos(lat2) * std::cos(dlon);
  return normalize_heading_deg(rad_to_deg(std::atan2(y, x)));
}

// --- Atmosphere wrapper ---------------------------------------------------

struct LocalAtmosphereConfig {
  std::string model = "US76";
  double exponentialRho0 = 1.225;          // kg/m^3
  double exponentialScaleHeightM = 7200.0;  // m
};

bool atmosphere_model_supported(const std::string& model) {
  return model == "US76" || model == "US76_EXPONENTIAL_EXTENSION" ||
         model == "EXPONENTIAL";
}

double atmosphere_ceiling_m(const LocalAtmosphereConfig& cfg) {
  return cfg.model == "US76" ? kUs76CeilingM : kAtmosphereCutoffM;
}

double atmosphere_density_kg_m3(const LocalAtmosphereConfig& cfg, double altitude_m) {
  if (cfg.model == "EXPONENTIAL") {
    return cfg.exponentialRho0 * std::exp(-altitude_m / cfg.exponentialScaleHeightM);
  }
  if (altitude_m > atmosphere_ceiling_m(cfg)) {
    return 0.0;
  }
  return atmosphere_for_model(altitude_m, cfg.model).densityKgM3;
}

// Hypersonic-condition evaluation that understands the analytic EXPONENTIAL
// model (the shared helper only knows US76 variants and would NaN-poison the
// output, which is not valid JSON).  The EXPONENTIAL model is hydrostatic
// isothermal, so T = g0 * H / R keeps density, pressure, and temperature
// self-consistent.  Formulas mirror sdn_hypersonics::compute_condition.
HypersonicCondition condition_for(
  const Sample& sample,
  const Vehicle& vehicle,
  const LocalAtmosphereConfig& cfg
) {
  if (cfg.model != "EXPONENTIAL") {
    return compute_condition(sample, vehicle, cfg.model);
  }
  AtmosphereState atmosphere{};
  atmosphere.temperatureK = kG0 * cfg.exponentialScaleHeightM / kGasConstant;
  atmosphere.densityKgM3 =
    cfg.exponentialRho0 * std::exp(-sample.altitudeM / cfg.exponentialScaleHeightM);
  atmosphere.pressurePa = atmosphere.densityKgM3 * kGasConstant * atmosphere.temperatureK;
  atmosphere.soundSpeedMps = std::sqrt(kGamma * kGasConstant * atmosphere.temperatureK);

  HypersonicCondition condition{};
  condition.sample = sample;
  condition.atmosphere = atmosphere;
  condition.mach = atmosphere.soundSpeedMps > 0.0
    ? sample.speedMps / atmosphere.soundSpeedMps
    : 0.0;
  condition.dynamicPressurePa =
    0.5 * atmosphere.densityKgM3 * sample.speedMps * sample.speedMps;
  const double nose_radius_m = std::max(vehicle.noseRadiusM, 0.01);
  condition.stagnationHeatFluxWm2 =
    1.83e-4 * std::sqrt(std::max(atmosphere.densityKgM3, 0.0) / nose_radius_m) *
    sample.speedMps * sample.speedMps * sample.speedMps;
  const double mu = dynamic_viscosity_pa_s(atmosphere.temperatureK);
  condition.reynoldsNumber =
    mu > 0.0
      ? atmosphere.densityKgM3 * sample.speedMps *
          std::max(vehicle.referenceLengthM, 0.01) / mu
      : 0.0;
  const double mass_kg = sample.massKg > 0.0 ? sample.massKg : vehicle.massKg;
  condition.loadFactorG =
    mass_kg > 0.0
      ? condition.dynamicPressurePa * vehicle.referenceAreaM2 / (mass_kg * kG0)
      : 0.0;
  return condition;
}

// --- Entry configuration ----------------------------------------------------

struct EntryConfig {
  double massKg = 9616.0;          // Crew Dragon reentry-configuration mass (public figure)
  double dragAreaM2 = 12.3;        // ~3.96 m max diameter capsule cross-section
  double dragCoefficient = 1.3;    // hypersonic capsule trim CD (Apollo AS-202)
  double liftToDragRatio = 0.18;   // Crew Dragon hypersonic trim L/D (SpaceX/AIAA paper)
  double bankAngleDeg = 0.0;       // 0 = lift-up; ballistic when L/D = 0
  double entryLatDeg = 26.5;
  double entryLonDeg = -110.0;
  double entryAltM = 121920.0;     // 400,000 ft NASA entry interface
  double entrySpeedMps = 7650.0;
  double entryFpaDeg = -1.55;
  double headingDeg = 90.0;
  double terminalAltitudeM = 5486.0;  // 18,000 ft drogue deploy (NASA Crew-8 blog)
  double durationSeconds = 2000.0;
  double sampleStepSeconds = 2.0;
  LocalAtmosphereConfig atmosphere;
  bool hasInitialState = false;
  Vec3 initialPositionEcefM;
  Vec3 initialVelocityEcefMps;
  double epochOffsetSeconds = 0.0;
};

EntryConfig parse_entry_config(const std::string& request, const Vehicle& vehicle) {
  EntryConfig config{};
  const std::string entry = object_value(request, "entryInterface");
  const std::string impact = object_value(request, "targetImpact");
  const std::string corridor = object_value(request, "corridor");
  const std::string vehicle_obj = object_value(request, "vehicle");
  const std::string initial_state = object_value(request, "initialState");

  config.massKg = vehicle.massKg > 0.0 ? vehicle.massKg : config.massKg;
  config.dragAreaM2 = vehicle.referenceAreaM2 > 0.0 ? vehicle.referenceAreaM2 : config.dragAreaM2;
  config.dragCoefficient = number_value(
    vehicle_obj, "dragCoefficient", number_value(request, "dragCoefficient", config.dragCoefficient));
  config.liftToDragRatio = number_value(
    vehicle_obj, "liftToDragRatio", number_value(request, "liftToDragRatio", config.liftToDragRatio));
  config.bankAngleDeg = number_value(
    corridor, "bankAngleDeg", number_value(request, "bankAngleDeg", config.bankAngleDeg));

  config.entryLatDeg = number_value(entry, "latitudeDeg", config.entryLatDeg);
  config.entryLonDeg = number_value(entry, "longitudeDeg", config.entryLonDeg);
  config.entryAltM = number_value(entry, "altitudeM", config.entryAltM);
  config.entrySpeedMps = number_value(entry, "speedMps", config.entrySpeedMps);
  config.entryFpaDeg = number_value(entry, "flightPathAngleDeg", config.entryFpaDeg);

  const double impact_lat = number_value(impact, "latitudeDeg", 1.0e9);
  const double impact_lon = number_value(impact, "longitudeDeg", 1.0e9);
  if (impact_lat < 1.0e8 && impact_lon < 1.0e8) {
    config.headingDeg = heading_between_deg(
      config.entryLatDeg, config.entryLonDeg, impact_lat, impact_lon);
  }
  config.headingDeg = number_value(entry, "headingDeg", config.headingDeg);

  double terminal = number_value(corridor, "terminalAltitudeM", -1.0e9);
  if (terminal < -1.0e8) {
    terminal = number_value(impact, "altitudeM", config.terminalAltitudeM);
  }
  config.terminalAltitudeM = std::max(0.0, terminal);

  config.durationSeconds = std::max(10.0, number_value(corridor, "durationSeconds", config.durationSeconds));
  config.sampleStepSeconds =
    std::max(0.05, number_value(corridor, "sampleStepSeconds", config.sampleStepSeconds));

  config.atmosphere.model = string_value(request, "atmosphereModel", "US76");
  config.atmosphere.exponentialRho0 =
    number_value(request, "atmosphereRho0KgM3", config.atmosphere.exponentialRho0);
  config.atmosphere.exponentialScaleHeightM =
    number_value(request, "atmosphereScaleHeightM", config.atmosphere.exponentialScaleHeightM);

  if (!initial_state.empty()) {
    Vec3 position{};
    Vec3 velocity{};
    if (number_array3(initial_state, "positionEcefM", &position) &&
        number_array3(initial_state, "velocityEcefMps", &velocity)) {
      config.hasInitialState = true;
      config.initialPositionEcefM = position;
      config.initialVelocityEcefMps = velocity;
      const double state_mass = number_value(initial_state, "massKg", -1.0);
      if (state_mass > 0.0) {
        config.massKg = state_mass;
      }
      config.epochOffsetSeconds = number_value(initial_state, "epochOffsetSeconds", 0.0);
    }
  }

  return config;
}

// --- Integration -----------------------------------------------------------

struct ReentryTrajectoryPoint {
  Sample sample;
  double latitudeDeg = 0.0;
  double longitudeDeg = 0.0;
  double downrangeM = 0.0;
  double headingDeg = 0.0;
  Vec3 positionEcefM;
  Vec3 velocityEcefMps;
  std::string phase;
};

struct EntryState {
  Vec3 r;
  Vec3 v;
};

struct EntryResult {
  std::vector<ReentryTrajectoryPoint> points;
  bool terminalReached = false;
  Vec3 terminalPositionEcefM;
  Vec3 terminalVelocityEcefMps;
  double terminalElapsedSeconds = 0.0;
};

Vec3 entry_acceleration(const EntryConfig& config, const EntryState& state) {
  const double r_mag = std::max(norm(state.r), 1.0);
  Vec3 accel = state.r * (-kEarthMuM3S2 / (r_mag * r_mag * r_mag));
  const double w = kEarthRotationRadS;
  accel.x += w * w * state.r.x + 2.0 * w * state.v.y;
  accel.y += w * w * state.r.y - 2.0 * w * state.v.x;

  double lat = 0.0;
  double lon = 0.0;
  double alt = 0.0;
  ecef_to_geodetic(state.r, &lat, &lon, &alt);
  const double rho = atmosphere_density_kg_m3(config.atmosphere, alt);
  const double speed = norm(state.v);
  if (rho > 0.0 && speed > 0.1) {
    const double q_over_m =
      0.5 * rho * speed * speed * config.dragAreaM2 / std::max(config.massKg, 1.0);
    const Vec3 v_hat = state.v * (1.0 / speed);
    // Drag opposes the airspeed vector (atmosphere co-rotates with ECEF).
    accel = accel - v_hat * (q_over_m * config.dragCoefficient);
    // Lift perpendicular to velocity, rotated about it by the bank angle.
    if (config.liftToDragRatio > 0.0) {
      const Vec3 r_hat = normalized(state.r);
      Vec3 up_perp = r_hat - v_hat * dot(r_hat, v_hat);
      const double up_perp_norm = norm(up_perp);
      if (up_perp_norm > 1.0e-6) {
        up_perp = up_perp * (1.0 / up_perp_norm);
        const Vec3 side = cross(v_hat, up_perp);
        const double bank = deg_to_rad(config.bankAngleDeg);
        const Vec3 lift_dir = up_perp * std::cos(bank) + side * std::sin(bank);
        accel = accel + lift_dir *
          (q_over_m * config.dragCoefficient * config.liftToDragRatio);
      }
    }
  }
  return accel;
}

EntryState rk4_step(const EntryConfig& config, const EntryState& state, double h) {
  const Vec3 k1v = entry_acceleration(config, state);
  const Vec3 k1r = state.v;
  const EntryState s2{state.r + k1r * (h * 0.5), state.v + k1v * (h * 0.5)};
  const Vec3 k2v = entry_acceleration(config, s2);
  const Vec3 k2r = s2.v;
  const EntryState s3{state.r + k2r * (h * 0.5), state.v + k2v * (h * 0.5)};
  const Vec3 k3v = entry_acceleration(config, s3);
  const Vec3 k3r = s3.v;
  const EntryState s4{state.r + k3r * h, state.v + k3v * h};
  const Vec3 k4v = entry_acceleration(config, s4);
  const Vec3 k4r = s4.v;
  EntryState out{};
  out.r = state.r + (k1r + k2r * 2.0 + k3r * 2.0 + k4r) * (h / 6.0);
  out.v = state.v + (k1v + k2v * 2.0 + k3v * 2.0 + k4v) * (h / 6.0);
  return out;
}

double geodetic_altitude(const Vec3& r) {
  double lat = 0.0;
  double lon = 0.0;
  double alt = 0.0;
  ecef_to_geodetic(r, &lat, &lon, &alt);
  return alt;
}

ReentryTrajectoryPoint make_point(
  const EntryConfig& config,
  double t,
  const EntryState& state,
  double start_lat_deg,
  double start_lon_deg,
  const std::string& phase,
  size_t index
) {
  ReentryTrajectoryPoint point{};
  double lat = 0.0;
  double lon = 0.0;
  double alt = 0.0;
  ecef_to_geodetic(state.r, &lat, &lon, &alt);
  const double speed = norm(state.v);
  point.sample.elapsedSeconds = t;
  point.sample.altitudeM = alt;
  point.sample.speedMps = speed;
  point.sample.massKg = config.massKg;
  Vec3 east;
  Vec3 north;
  Vec3 up;
  enu_basis(lat, lon, &east, &north, &up);
  if (speed > 1.0) {
    const double v_up = dot(state.v, up);
    point.sample.flightPathAngleDeg =
      rad_to_deg(std::asin(std::max(-1.0, std::min(1.0, v_up / speed))));
    const double v_east = dot(state.v, east);
    const double v_north = dot(state.v, north);
    if (std::hypot(v_east, v_north) > 0.5) {
      point.headingDeg = normalize_heading_deg(rad_to_deg(std::atan2(v_east, v_north)));
    } else {
      point.headingDeg = config.headingDeg;
    }
  } else {
    point.sample.flightPathAngleDeg = -90.0;
    point.headingDeg = config.headingDeg;
  }
  point.latitudeDeg = lat;
  point.longitudeDeg = lon;
  const double lat1 = deg_to_rad(start_lat_deg);
  const double lat2 = deg_to_rad(lat);
  const double dlon = deg_to_rad(lon - start_lon_deg);
  const double sin_half_dlat = std::sin((lat2 - lat1) * 0.5);
  const double sin_half_dlon = std::sin(dlon * 0.5);
  const double a =
    sin_half_dlat * sin_half_dlat + std::cos(lat1) * std::cos(lat2) * sin_half_dlon * sin_half_dlon;
  point.downrangeM =
    2.0 * std::atan2(std::sqrt(a), std::sqrt(std::max(0.0, 1.0 - a))) * kEarthMeanRadiusM;
  point.positionEcefM = state.r;
  point.velocityEcefMps = state.v;
  point.phase = phase;
  point.sample.id = phase + "-" + std::to_string(index);
  return point;
}

EntryResult integrate_entry(const EntryConfig& config) {
  EntryResult result{};

  EntryState state{};
  if (config.hasInitialState) {
    state.r = config.initialPositionEcefM;
    state.v = config.initialVelocityEcefMps;
  } else {
    state.r = geodetic_to_ecef(config.entryLatDeg, config.entryLonDeg, config.entryAltM);
    Vec3 east;
    Vec3 north;
    Vec3 up;
    enu_basis(config.entryLatDeg, config.entryLonDeg, &east, &north, &up);
    const double azimuth = deg_to_rad(config.headingDeg);
    const double gamma = deg_to_rad(config.entryFpaDeg);
    const Vec3 horizontal = east * std::sin(azimuth) + north * std::cos(azimuth);
    state.v = (horizontal * std::cos(gamma) + up * std::sin(gamma)) * config.entrySpeedMps;
  }

  double start_lat = 0.0;
  double start_lon = 0.0;
  double start_alt = 0.0;
  ecef_to_geodetic(state.r, &start_lat, &start_lon, &start_alt);

  const double dt_target = 0.05;  // fixed internal RK4 step (<= 1 s requirement)
  const double t_end = config.durationSeconds;
  double t = 0.0;
  size_t sample_index = 0;

  auto phase_for = [&](double alt, double speed, bool terminal) -> std::string {
    if (terminal) {
      return config.terminalAltitudeM > 100.0 ? "terminal" : "impact";
    }
    if (speed > 3000.0) {
      return "hypersonic-entry";
    }
    if (speed > 500.0) {
      return "deceleration";
    }
    (void)alt;
    return "terminal-descent";
  };

  result.points.push_back(
    make_point(config, 0.0, state, start_lat, start_lon, "entry-interface", sample_index));
  ++sample_index;

  bool done = false;
  double next_sample_t = config.sampleStepSeconds;
  while (t < t_end - 1e-9 && !done) {
    const double t_target = std::min(next_sample_t, t_end);
    const int substeps = std::max(1, static_cast<int>(std::ceil((t_target - t) / dt_target)));
    const double h = (t_target - t) / substeps;
    for (int step = 0; step < substeps && !done; ++step) {
      const EntryState prev = state;
      const double t_prev = t;
      state = rk4_step(config, state, h);
      t += h;
      const double alt_prev = geodetic_altitude(prev.r);
      const double alt_now = geodetic_altitude(state.r);
      if (alt_now <= config.terminalAltitudeM && alt_prev > config.terminalAltitudeM) {
        // Refine the terminal-altitude crossing with one secant pass.
        const double fraction =
          (alt_prev - config.terminalAltitudeM) / std::max(alt_prev - alt_now, 1e-9);
        state = rk4_step(config, prev, h * fraction);
        t = t_prev + h * fraction;
        result.terminalReached = true;
        done = true;
      }
    }

    const bool is_terminal = done || t >= t_end - 1e-9;
    result.points.push_back(make_point(
      config,
      t,
      state,
      start_lat,
      start_lon,
      phase_for(geodetic_altitude(state.r), norm(state.v), is_terminal && result.terminalReached),
      sample_index));
    ++sample_index;
    if (std::fabs(t - next_sample_t) < 1e-6) {
      next_sample_t += config.sampleStepSeconds;
    } else if (t > next_sample_t) {
      while (next_sample_t <= t + 1e-9) {
        next_sample_t += config.sampleStepSeconds;
      }
    }
  }

  result.terminalPositionEcefM = state.r;
  result.terminalVelocityEcefMps = state.v;
  result.terminalElapsedSeconds = t;
  return result;
}

// --- JSON serialization ------------------------------------------------- --

std::string trajectory_samples_json(const std::vector<HypersonicCondition>& conditions) {
  std::string output = "[";
  for (size_t index = 0; index < conditions.size(); ++index) {
    if (index > 0) {
      output += ",";
    }
    output += condition_json(conditions[index]);
  }
  output += "]";
  return output;
}

double max_heading_step_deg(const std::vector<ReentryTrajectoryPoint>& points) {
  double max_step = 0.0;
  for (size_t index = 1; index < points.size(); ++index) {
    max_step = std::max(max_step, heading_delta_deg(points[index - 1].headingDeg, points[index].headingDeg));
  }
  return max_step;
}

std::string vec3_json(const Vec3& value) {
  char buffer[128];
  std::snprintf(buffer, sizeof(buffer), "[%.12g,%.12g,%.12g]", value.x, value.y, value.z);
  return buffer;
}

std::string generated_trajectory_json(const std::vector<ReentryTrajectoryPoint>& points) {
  std::string output = "[";
  for (size_t index = 0; index < points.size(); ++index) {
    if (index > 0) {
      output += ",";
    }
    const auto& point = points[index];
    char buffer[2048];
    std::snprintf(
      buffer,
      sizeof(buffer),
      "{\"id\":%s,\"phase\":%s,\"elapsedSeconds\":%.12g,\"latitudeDeg\":%.12g,"
      "\"longitudeDeg\":%.12g,\"downrangeM\":%.12g,\"headingDeg\":%.12g,"
      "\"altitudeM\":%.12g,\"speedMps\":%.12g,\"massKg\":%.12g,"
      "\"flightPathAngleDeg\":%.12g,"
      "\"positionEcefM\":%s,\"velocityEcefMps\":%s}",
      quote(point.sample.id).c_str(),
      quote(point.phase).c_str(),
      point.sample.elapsedSeconds,
      point.latitudeDeg,
      point.longitudeDeg,
      point.downrangeM,
      point.headingDeg,
      point.sample.altitudeM,
      point.sample.speedMps,
      point.sample.massKg,
      point.sample.flightPathAngleDeg,
      vec3_json(point.positionEcefM).c_str(),
      vec3_json(point.velocityEcefMps).c_str());
    output += buffer;
  }
  output += "]";
  return output;
}

std::string generated_impact_json(const ReentryTrajectoryPoint& point) {
  char buffer[1024];
  std::snprintf(
    buffer,
    sizeof(buffer),
    "{\"sampleId\":%s,\"elapsedSeconds\":%.12g,\"altitudeM\":%.12g,\"speedMps\":%.12g,"
    "\"latitudeDeg\":%.12g,\"longitudeDeg\":%.12g}",
    quote(point.sample.id).c_str(),
    point.sample.elapsedSeconds,
    point.sample.altitudeM,
    point.sample.speedMps,
    point.latitudeDeg,
    point.longitudeDeg);
  return buffer;
}

std::string terminal_state_json(const EntryResult& result, const EntryConfig& config) {
  char buffer[512];
  std::snprintf(
    buffer,
    sizeof(buffer),
    "{\"positionEcefM\":%s,\"velocityEcefMps\":%s,\"massKg\":%.12g,"
    "\"epochOffsetSeconds\":%.12g}",
    vec3_json(result.terminalPositionEcefM).c_str(),
    vec3_json(result.terminalVelocityEcefMps).c_str(),
    config.massKg,
    config.epochOffsetSeconds + result.terminalElapsedSeconds);
  return buffer;
}

std::string delta_v_json(const std::string& request) {
  const std::string stable_orbit = object_value(request, "stableOrbit");
  const std::string entry = object_value(request, "entryInterface");
  const double orbit_alt = number_value(stable_orbit, "altitudeM", 420000.0);
  const double entry_alt = number_value(entry, "altitudeM", 80000.0);
  const double r1 = kEarthMeanRadiusM + std::max(orbit_alt, entry_alt + 1000.0);
  const double r2 = kEarthMeanRadiusM + std::max(entry_alt, 1000.0);
  const double circular_speed = std::sqrt(kEarthMuM3S2 / r1);
  const double transfer_apogee_speed = std::sqrt(kEarthMuM3S2 * (2.0 / r1 - 2.0 / (r1 + r2)));
  const double deorbit = std::fabs(circular_speed - transfer_apogee_speed) + 25.0;
  char buffer[768];
  std::snprintf(
    buffer,
    sizeof(buffer),
    "{\"fromStableOrbitDeorbitMps\":%.12g,\"orbitAltitudeM\":%.12g,"
    "\"entryInterfaceAltitudeM\":%.12g,"
    "\"assumptions\":[\"two-body transfer from circular orbit to entry interface\","
    "\"reported delta-v includes 25 m/s targeting margin\"]}",
    deorbit,
    orbit_alt,
    entry_alt);
  return buffer;
}

}  // namespace

extern "C" int simulate_reentry(void) {
  plugin_reset_output_state();

  const std::string request = payload_for_port("scenario");
  if (request.empty()) {
    return fail("missing-scenario", "Input port \"scenario\" is required.");
  }

  const std::string atmosphere_provider =
    string_value(request, "atmosphereProvider", "atmosphere-model");
  const std::string hypersonics_provider =
    string_value(request, "hypersonicsProvider", "hypersonics-propagator");
  const std::string atmosphere_model =
    string_value(request, "atmosphereModel", "US76");
  if (!atmosphere_model_supported(atmosphere_model)) {
    const AtmosphereState invalid = atmosphere_for_model(0.0, atmosphere_model);
    const std::string message = invalid.error.empty()
      ? ("Unsupported atmosphere model \"" + atmosphere_model +
         "\". Supported models: \"US76\", \"US76_EXPONENTIAL_EXTENSION\", "
         "\"EXPONENTIAL\".")
      : invalid.error;
    return fail("unsupported-atmosphere-model", message.c_str());
  }
  LocalAtmosphereConfig condition_atmosphere{};
  condition_atmosphere.model = atmosphere_model;
  condition_atmosphere.exponentialRho0 =
    number_value(request, "atmosphereRho0KgM3", condition_atmosphere.exponentialRho0);
  condition_atmosphere.exponentialScaleHeightM = number_value(
    request, "atmosphereScaleHeightM", condition_atmosphere.exponentialScaleHeightM);
  const Vehicle vehicle = parse_vehicle(request);
  std::vector<Sample> samples = parse_samples(request, "samples");

  EntryResult entry_result{};
  EntryConfig config{};
  bool generated = false;
  if (samples.empty()) {
    const std::string entry = object_value(request, "entryInterface");
    const std::string initial_state = object_value(request, "initialState");
    if (!entry.empty() || !initial_state.empty()) {
      config = parse_entry_config(request, vehicle);
      entry_result = integrate_entry(config);
      generated = !entry_result.points.empty();
      if (generated) {
        samples.reserve(entry_result.points.size());
        for (const auto& point : entry_result.points) {
          samples.push_back(point.sample);
        }
      }
    }
  }
  if (samples.empty()) {
    return fail("missing-trajectory", "Request must include samples, entryInterface, or initialState.");
  }

  std::vector<HypersonicCondition> conditions;
  conditions.reserve(samples.size());
  for (const auto& sample : samples) {
    conditions.push_back(condition_for(sample, vehicle, condition_atmosphere));
  }

  size_t peak_q_index = 0;
  size_t peak_heat_index = 0;
  size_t impact_index = conditions.size() - 1;
  for (size_t index = 0; index < conditions.size(); ++index) {
    if (conditions[index].dynamicPressurePa > conditions[peak_q_index].dynamicPressurePa) {
      peak_q_index = index;
    }
    if (conditions[index].stagnationHeatFluxWm2 > conditions[peak_heat_index].stagnationHeatFluxWm2) {
      peak_heat_index = index;
    }
    if (conditions[index].sample.altitudeM <= 0.0) {
      impact_index = index;
    }
  }

  const auto& peak_q = conditions[peak_q_index];
  const auto& peak_heat = conditions[peak_heat_index];
  const auto& impact = conditions[impact_index];

  char summary[1536];
  std::snprintf(
    summary,
    sizeof(summary),
    "\"peakDynamicPressure\":{\"sampleId\":%s,\"elapsedSeconds\":%.12g,\"valuePa\":%.12g},"
    "\"peakHeating\":{\"sampleId\":%s,\"elapsedSeconds\":%.12g,\"valueWm2\":%.12g}",
    quote(peak_q.sample.id).c_str(),
    peak_q.sample.elapsedSeconds,
    peak_q.dynamicPressurePa,
    quote(peak_heat.sample.id).c_str(),
    peak_heat.sample.elapsedSeconds,
    peak_heat.stagnationHeatFluxWm2);

  char impact_summary[768];
  std::snprintf(
    impact_summary,
    sizeof(impact_summary),
    "{\"sampleId\":%s,\"elapsedSeconds\":%.12g,\"altitudeM\":%.12g,\"speedMps\":%.12g}",
    quote(impact.sample.id).c_str(),
    impact.sample.elapsedSeconds,
    impact.sample.altitudeM,
    impact.sample.speedMps);

  std::string outcome = "impact";
  if (generated) {
    if (!entry_result.terminalReached) {
      outcome = "duration-cap";
    } else if (config.terminalAltitudeM > 100.0) {
      outcome = "terminal-altitude";
    }
  }

  std::string response =
    "{\"provider\":\"reentry-analysis\","
    "\"atmosphereProvider\":" + quote(atmosphere_provider) + ","
    "\"hypersonicsProvider\":" + quote(hypersonics_provider) + ","
    "\"atmosphereModel\":" + quote(atmosphere_model) + ","
    "\"outcome\":" + quote(outcome) + ","
    "\"trajectorySource\":" + quote(generated ? "module-generated-entry-corridor" : "request-samples") + "," +
    "\"trajectorySamples\":" + (generated ? generated_trajectory_json(entry_result.points) : trajectory_samples_json(conditions)) + "," +
    std::string(summary) + ","
    "\"impactPoint\":" + (generated ? generated_impact_json(entry_result.points.back()) : std::string(impact_summary)) + ","
    "\"terminalState\":" + (generated ? terminal_state_json(entry_result, config) : "null") + ","
    "\"trajectoryGeometry\":{\"sampleCount\":" + std::to_string(samples.size()) +
      ",\"maxHeadingStepDeg\":" + std::to_string(max_heading_step_deg(entry_result.points)) + "},"
    "\"deltaV\":" + delta_v_json(request) + ","
    "\"hypersonicConditions\":" + join_conditions(conditions) + ","
    "\"events\":["
    "{\"event\":\"entry_interface\",\"sampleId\":" + quote(conditions.front().sample.id) + "},"
    "{\"event\":\"peak_dynamic_pressure\",\"sampleId\":" + quote(peak_q.sample.id) + "},"
    "{\"event\":\"impact\",\"sampleId\":" + quote(impact.sample.id) + "}"
    "],"
    "\"assumptions\":[\"RK4 3-DOF drag-lift entry integration in the rotating ECEF frame\","
    "\"lift modeled with constant L/D and bank angle; ballistic when L/D = 0\","
    "\"atmosphere provider composed through model selection; US76 is vacuum above its 86 km ceiling, the exponential extension above 150 km\","
    "\"hypersonic conditions computed with Sutton-Graves heating\"]}";

  return emit_json("reentry", "REM.fbs", "$REM", response);
}
