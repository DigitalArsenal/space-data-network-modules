using namespace sdn_hypersonics;

// ---------------------------------------------------------------------------
// Launch-ascent 3-DOF point-mass integrator.
//
// Replaces the former kinematic scenario generator with a real RK4 integrator:
//   state  = ECEF position (m), ECEF velocity (m/s), total mass (kg)
//   forces = thrust along the commanded direction (vertical rise -> pitch-over
//            -> zero-AoA gravity turn -> closed-loop upper-stage steering
//            toward the target orbit), inverse-square gravity, aerodynamic
//            drag against the shared atmosphere (atmosphere_for_model), and
//            the rotating-frame Coriolis/centrifugal terms.
//   mass   = dm/dt = -throttle * mdot, mdot = T_vac / (Isp_vac * g0).
//
// Default vehicle parameters model Falcon 9 Block 5 + Crew Dragon:
//   - 9 x Merlin 1D first stage: 7,607 kN sea level / 8,227 kN vacuum total,
//     Isp 283 s SL / 312 s vac.  Sources: SpaceX Falcon 9 overview page
//     (https://www.spacex.com/vehicles/falcon-9/) and NASA Crew-8 Mission
//     Overview (9 x 190,000 lbf sea level).
//   - First-stage propellant 411,000 kg, dry 22,200 kg; second stage MVac
//     934 kN vac, Isp 348 s, propellant 107,500 kg, dry 4,000 kg.  Public
//     engineering estimates: spaceflight101.com Falcon 9 FT/Block 5 data
//     sheet (masses are not published by SpaceX directly).
//   - Crew Dragon payload mass ~12,500 kg (SpaceX Dragon 2 public figures).
//   - Crew ascent profile timing (stage-1 burn 158 s, stage-2 ignition at
//     MECO + 11 s, max-Q throttle bucket 44-71 s, sensed-acceleration limit
//     ~3.3 g) from the published Crew Dragon Demo-1 webcast telemetry
//     dataset: github.com/shahar603/Telemetry-Data (DM-1/JSON/events.json,
//     analysed.json).
// ---------------------------------------------------------------------------

namespace {

constexpr double kPi = 3.141592653589793238462643383279502884;
constexpr double kEarthMeanRadiusM = 6371008.8;
constexpr double kEarthMuM3S2 = 3.986004418e14;
constexpr double kEarthRotationRadS = 7.292115e-5;
constexpr double kWgs84A = 6378137.0;
constexpr double kWgs84F = 1.0 / 298.257223563;
constexpr double kWgs84E2 = kWgs84F * (2.0 - kWgs84F);
constexpr double kG0 = 9.80665;
constexpr double kSeaLevelPressurePa = 101325.0;
// US76 is tabulated to 86 km; the shared helper clamps above that, which
// would impose a constant (unphysically large) density on orbital altitudes,
// so the integrator treats "US76" as vacuum above its 86 km validity ceiling.
// The honest exponential extension stays usable to 150 km, above which
// dynamic pressure is negligible on ascent/entry time scales.
constexpr double kUs76CeilingM = 86000.0;
constexpr double kAtmosphereCutoffM = 150000.0;

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
double clamp01(double value) { return std::max(0.0, std::min(1.0, value)); }
double smoothstep(double value) {
  const double u = clamp01(value);
  return u * u * (3.0 - 2.0 * u);
}
double clamp_throttle(double value) { return std::max(0.0, std::min(1.1, value)); }

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

// --- WGS84 conversions ------------------------------------------------------

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

// --- Request parsing helpers --------------------------------------------- --

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

bool bool_value(const std::string& json, const std::string& key, bool fallback) {
  const size_t key_pos = json.find("\"" + key + "\"");
  if (key_pos == std::string::npos) {
    return fallback;
  }
  const size_t colon = json.find(':', key_pos);
  if (colon == std::string::npos) {
    return fallback;
  }
  size_t cursor = colon + 1;
  while (
    cursor < json.size() &&
    (json[cursor] == ' ' || json[cursor] == '\n' || json[cursor] == '\t' || json[cursor] == '\r')
  ) {
    ++cursor;
  }
  if (json.compare(cursor, 4, "true") == 0) {
    return true;
  }
  if (json.compare(cursor, 5, "false") == 0) {
    return false;
  }
  return fallback;
}

struct ThrottlePoint {
  double elapsedSeconds = 0.0;
  double throttle = 1.0;
};

std::vector<ThrottlePoint> parse_throttle_schedule(
  const std::string& guidance,
  double duration
) {
  std::vector<ThrottlePoint> schedule;
  if (!guidance.empty()) {
    schedule.push_back({0.0, clamp_throttle(number_value(guidance, "throttle", 1.0))});
  } else {
    schedule.push_back({0.0, 1.0});
  }

  bool has_explicit_schedule = false;
  const size_t key = guidance.find("\"throttleSchedule\"");
  if (key != std::string::npos) {
    const size_t array_start = guidance.find('[', key);
    if (array_start != std::string::npos) {
      int depth = 0;
      size_t array_end = std::string::npos;
      for (size_t i = array_start; i < guidance.size(); ++i) {
        if (guidance[i] == '[') {
          ++depth;
        } else if (guidance[i] == ']') {
          --depth;
          if (depth == 0) {
            array_end = i;
            break;
          }
        }
      }
      if (array_end != std::string::npos) {
        size_t cursor = array_start + 1;
        while (cursor < array_end) {
          const size_t object_start = guidance.find('{', cursor);
          if (object_start == std::string::npos || object_start >= array_end) {
            break;
          }
          int object_depth = 0;
          size_t object_end = std::string::npos;
          for (size_t i = object_start; i <= array_end; ++i) {
            if (guidance[i] == '{') {
              ++object_depth;
            } else if (guidance[i] == '}') {
              --object_depth;
              if (object_depth == 0) {
                object_end = i;
                break;
              }
            }
          }
          if (object_end == std::string::npos) {
            break;
          }
          const std::string object = guidance.substr(object_start, object_end - object_start + 1);
          schedule.push_back({
            std::max(0.0, number_value(
              object,
              "elapsedSeconds",
              number_value(object, "timeSeconds", 0.0)
            )),
            clamp_throttle(number_value(object, "throttle", 1.0)),
          });
          has_explicit_schedule = true;
          cursor = object_end + 1;
        }
      }
    }
  }

  const double upper_stage_throttle = number_value(guidance, "upperStageThrottle", -1.0);
  if (upper_stage_throttle >= 0.0) {
    schedule.push_back({duration * 0.33, clamp_throttle(upper_stage_throttle)});
    has_explicit_schedule = true;
  }

  if (!has_explicit_schedule) {
    // Default max-Q throttle bucket.  The Crew Dragon Demo-1 webcast telemetry
    // (github.com/shahar603/Telemetry-Data, DM-1/JSON/events.json) shows the
    // first stage throttling down between T+44 s and T+71 s; depth ~0.72 is a
    // tuned engineering estimate consistent with the sensed-acceleration dip.
    schedule.push_back({44.0, 0.65});
    schedule.push_back({71.0, 1.0});
  }

  std::sort(schedule.begin(), schedule.end(), [](const auto& left, const auto& right) {
    return left.elapsedSeconds < right.elapsedSeconds;
  });

  std::vector<ThrottlePoint> deduped;
  for (const auto& point : schedule) {
    if (!deduped.empty() && std::fabs(deduped.back().elapsedSeconds - point.elapsedSeconds) < 1e-6) {
      deduped.back() = point;
    } else {
      deduped.push_back(point);
    }
  }
  if (deduped.empty() || deduped.front().elapsedSeconds > 0.0) {
    deduped.insert(deduped.begin(), {0.0, 1.0});
  }
  return deduped;
}

double throttle_at(const std::vector<ThrottlePoint>& schedule, double elapsedSeconds) {
  if (schedule.empty()) {
    return 1.0;
  }
  double throttle = schedule.front().throttle;
  for (const auto& point : schedule) {
    if (point.elapsedSeconds > elapsedSeconds) {
      break;
    }
    throttle = point.throttle;
  }
  return throttle;
}

// --- Atmosphere wrappers ------------------------------------------------- --

struct LocalAtmosphereConfig {
  std::string model = "US76";
  double exponentialRho0 = 1.225;        // kg/m^3, sea-level standard density
  double exponentialScaleHeightM = 7200.0;  // common engineering scale height
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

double atmosphere_pressure_pa(const LocalAtmosphereConfig& cfg, double altitude_m) {
  if (cfg.model == "EXPONENTIAL") {
    return kSeaLevelPressurePa * std::exp(-altitude_m / cfg.exponentialScaleHeightM);
  }
  if (altitude_m > atmosphere_ceiling_m(cfg)) {
    return 0.0;
  }
  return atmosphere_for_model(altitude_m, cfg.model).pressurePa;
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

// --- Vehicle / guidance configuration ------------------------------------ --

struct StageSpec {
  double thrustVacuumN = 0.0;
  double thrustSeaLevelN = 0.0;
  double ispVacuumS = 300.0;
  double burnSeconds = 0.0;
  double propellantMassKg = 0.0;
  double dryMassKg = 0.0;
  double coastAfterSeconds = 0.0;
  double mdotKgS() const { return thrustVacuumN / (std::max(ispVacuumS, 1.0) * kG0); }
};

struct AscentConfig {
  std::vector<StageSpec> stages;
  double payloadMassKg = 12500.0;
  double dragAreaM2 = 10.75;
  double dragCoefficient = 0.5;  // smooth slender LV, constant-Cd approximation
  double launchLatDeg = 28.608389;
  double launchLonDeg = -80.604333;
  double launchAltM = 3.0;
  double azimuthDeg = 73.0;
  double targetRadiusM = kEarthMeanRadiusM + 200000.0;
  double durationSeconds = 900.0;
  double sampleStepSeconds = -1.0;  // <=0 -> automatic (2 s below 100 km, 10 s above)
  double verticalRiseSeconds = 8.0;
  double pitchOverDurationSeconds = 16.0;
  double pitchKickAngleDeg = 2.5;       // tuned to the DM-1 lofted crew profile
  double maxSensedAccelG = 3.0;         // within DM-1 telemetry envelope (max ~3.3 g)
  double maxDynamicPressurePa = 75000.0;
  double steerGainKp = 1.2e-4;          // upper-stage PD altitude gains (tuned)
  double steerGainKd = 2.2e-2;
  double minPitchSin = -0.42;
  double maxPitchSin = 0.85;
  std::vector<ThrottlePoint> throttleSchedule;
  LocalAtmosphereConfig atmosphere;
  bool hasInitialState = false;
  Vec3 initialPositionEcefM;
  Vec3 initialVelocityEcefMps;
  double initialMassKg = -1.0;
  double epochOffsetSeconds = 0.0;
  bool explicitStagePlan = false;
  bool continueAfterTargetOrbit = false;
  double boosterMultiplier = 1.0;
};

std::vector<StageSpec> default_falcon9_stages() {
  // Falcon 9 Block 5 + Crew Dragon defaults (sources in the header comment).
  StageSpec stage1{};
  stage1.thrustVacuumN = 8.227e6;    // SpaceX: 9 x Merlin 1D vacuum total
  stage1.thrustSeaLevelN = 7.607e6;  // SpaceX/NASA Crew-8 overview: 1.71 Mlbf SL
  stage1.ispVacuumS = 312.0;         // Merlin 1D published vacuum Isp
  stage1.burnSeconds = 158.0;        // DM-1 webcast telemetry MECO at T+158 s
  stage1.propellantMassKg = 411000.0;  // spaceflight101 Falcon 9 FT data sheet
  stage1.dryMassKg = 22200.0;          // spaceflight101 Falcon 9 FT data sheet
  stage1.coastAfterSeconds = 11.0;     // DM-1 telemetry: SES-1 at T+169 s

  StageSpec stage2{};
  stage2.thrustVacuumN = 9.34e5;     // Merlin Vacuum (MVac) published thrust
  stage2.thrustSeaLevelN = 9.34e5;   // only fires exoatmospherically
  stage2.ispVacuumS = 348.0;         // MVac published vacuum Isp
  stage2.burnSeconds = 1.0e9;        // closed-loop cutoff (SECO) terminates burn
  stage2.propellantMassKg = 107500.0;  // spaceflight101 Falcon 9 FT data sheet
  stage2.dryMassKg = 4000.0;           // spaceflight101 Falcon 9 FT data sheet
  stage2.coastAfterSeconds = 0.0;
  return {stage1, stage2};
}

struct GuidanceStageRow {
  double startSeconds = 0.0;
  double endSeconds = 0.0;
  double throttle = 1.0;
  StageSpec stage;
};

void scale_first_stage_for_boosters(std::vector<StageSpec>* stages, double booster_multiplier) {
  if (!stages || stages->empty() || booster_multiplier <= 1.0) {
    return;
  }
  StageSpec& stage = (*stages)[0];
  stage.thrustVacuumN *= booster_multiplier;
  stage.thrustSeaLevelN *= booster_multiplier;
  stage.propellantMassKg *= booster_multiplier;
  stage.dryMassKg *= booster_multiplier;
}

std::vector<GuidanceStageRow> guidance_rows_from_stage_objects(
  const std::vector<std::string>& stage_objects
) {
  std::vector<GuidanceStageRow> rows;
  if (stage_objects.empty()) {
    return {};
  }
  const std::vector<StageSpec> defaults = default_falcon9_stages();
  rows.reserve(stage_objects.size());
  for (size_t index = 0; index < stage_objects.size(); ++index) {
    const std::string& object = stage_objects[index];
    const StageSpec base = index == 0 ? defaults[0] : defaults[1];
    const double fallback_start = rows.empty() ? 0.0 : rows.back().endSeconds;
    const double start = std::max(0.0, number_value(object, "startSeconds", fallback_start));
    const double end = std::max(start, number_value(object, "endSeconds", start + base.burnSeconds));
    GuidanceStageRow row{};
    row.startSeconds = start;
    row.endSeconds = end;
    row.stage = base;
    row.stage.burnSeconds = std::max(0.0, end - start);
    row.stage.coastAfterSeconds = 0.0;
    row.throttle = clamp_throttle(number_value(object, "throttle", 1.0));
    const double requested_propellant =
      row.stage.mdotKgS() * row.stage.burnSeconds * row.throttle;
    if (requested_propellant > 0.0 && base.propellantMassKg > 0.0) {
      const double tankage_scale = requested_propellant / base.propellantMassKg;
      row.stage.propellantMassKg = requested_propellant;
      row.stage.dryMassKg = base.dryMassKg * std::max(0.2, tankage_scale);
    }
    rows.push_back(row);
  }

  std::sort(rows.begin(), rows.end(), [](const auto& left, const auto& right) {
    return left.startSeconds < right.startSeconds;
  });
  return rows;
}

std::vector<StageSpec> stages_from_guidance_rows(
  const std::vector<GuidanceStageRow>& rows
) {
  std::vector<StageSpec> stages;
  stages.reserve(rows.size());
  for (size_t index = 0; index < rows.size(); ++index) {
    StageSpec stage = rows[index].stage;
    if (index + 1 < rows.size()) {
      stage.coastAfterSeconds = std::max(0.0, rows[index + 1].startSeconds - rows[index].endSeconds);
    }
    stages.push_back(stage);
  }
  return stages;
}

std::vector<ThrottlePoint> throttle_schedule_from_guidance_rows(
  const std::vector<GuidanceStageRow>& rows
) {
  std::vector<ThrottlePoint> schedule;
  schedule.reserve(rows.size() * 2 + 1);
  for (size_t index = 0; index < rows.size(); ++index) {
    const auto& row = rows[index];
    schedule.push_back({row.startSeconds, row.throttle});
    const bool next_starts_at_cutoff =
      index + 1 < rows.size() &&
      std::fabs(rows[index + 1].startSeconds - row.endSeconds) < 1e-6;
    if (!next_starts_at_cutoff) {
      schedule.push_back({row.endSeconds, 0.0});
    }
  }
  std::sort(schedule.begin(), schedule.end(), [](const auto& left, const auto& right) {
    return left.elapsedSeconds < right.elapsedSeconds;
  });
  std::vector<ThrottlePoint> deduped;
  for (const auto& point : schedule) {
    if (!deduped.empty() && std::fabs(deduped.back().elapsedSeconds - point.elapsedSeconds) < 1e-6) {
      deduped.back() = point;
    } else {
      deduped.push_back(point);
    }
  }
  return deduped;
}

AscentConfig parse_ascent_config(const std::string& request, const Vehicle& vehicle) {
  AscentConfig config{};
  const std::string launch_site = object_value(request, "launchSite");
  const std::string target_orbit = object_value(request, "targetOrbit");
  const std::string guidance = object_value(request, "guidance");
  const std::string initial_state = object_value(request, "initialState");

  config.launchLatDeg = number_value(launch_site, "latitudeDeg", config.launchLatDeg);
  config.launchLonDeg = number_value(launch_site, "longitudeDeg", config.launchLonDeg);
  config.launchAltM = number_value(launch_site, "altitudeM", config.launchAltM);
  config.azimuthDeg = number_value(target_orbit, "azimuthDeg", config.azimuthDeg);
  const double target_alt = number_value(target_orbit, "altitudeM", 200000.0);
  config.targetRadiusM = kEarthMeanRadiusM + std::max(target_alt, 1000.0);

  config.durationSeconds = std::max(60.0, number_value(guidance, "durationSeconds", 900.0));
  config.sampleStepSeconds = number_value(guidance, "sampleStepSeconds", -1.0);
  if (config.sampleStepSeconds > 0.0) {
    config.sampleStepSeconds = std::max(0.05, config.sampleStepSeconds);
  }
  config.verticalRiseSeconds =
    std::max(0.0, number_value(guidance, "verticalRiseSeconds", config.verticalRiseSeconds));
  config.pitchOverDurationSeconds =
    std::max(1.0, number_value(guidance, "pitchOverDurationSeconds", config.pitchOverDurationSeconds));
  config.pitchKickAngleDeg =
    number_value(guidance, "pitchKickAngleDeg", config.pitchKickAngleDeg);
  config.maxSensedAccelG =
    std::max(1.2, number_value(guidance, "maxSensedAccelerationG", config.maxSensedAccelG));
  config.maxDynamicPressurePa =
    std::max(0.0, number_value(guidance, "maxDynamicPressurePa", config.maxDynamicPressurePa));
  config.steerGainKp = number_value(guidance, "steerGainKp", config.steerGainKp);
  config.steerGainKd = number_value(guidance, "steerGainKd", config.steerGainKd);
  config.explicitStagePlan = bool_value(guidance, "explicitStagePlan", false);
  config.continueAfterTargetOrbit = bool_value(guidance, "continueAfterTargetOrbit", false);
  config.boosterMultiplier =
    std::max(1.0, number_value(guidance, "boosterMultiplier", config.boosterMultiplier));
  if (config.boosterMultiplier > 1.0) {
    const double boost_blend =
      std::min(1.0, std::log(config.boosterMultiplier) / std::log(9.0));
    if (guidance.find("\"verticalRiseSeconds\"") == std::string::npos) {
      config.verticalRiseSeconds =
        std::max(4.0, config.verticalRiseSeconds - 4.0 * boost_blend);
    }
    if (guidance.find("\"pitchOverDurationSeconds\"") == std::string::npos) {
      config.pitchOverDurationSeconds =
        std::max(8.0, config.pitchOverDurationSeconds - 8.0 * boost_blend);
    }
    if (guidance.find("\"pitchKickAngleDeg\"") == std::string::npos) {
      config.pitchKickAngleDeg += 5.5 * boost_blend;
    }
  }
  config.throttleSchedule = parse_throttle_schedule(guidance, config.durationSeconds);

  config.dragAreaM2 = vehicle.referenceAreaM2 > 0.0 ? vehicle.referenceAreaM2 : config.dragAreaM2;
  config.dragCoefficient = number_value(request, "dragCoefficient", config.dragCoefficient);
  config.payloadMassKg = number_value(request, "payloadMassKg", config.payloadMassKg);

  config.atmosphere.model = string_value(request, "atmosphereModel", "US76");
  config.atmosphere.exponentialRho0 =
    number_value(request, "atmosphereRho0KgM3", config.atmosphere.exponentialRho0);
  config.atmosphere.exponentialScaleHeightM =
    number_value(request, "atmosphereScaleHeightM", config.atmosphere.exponentialScaleHeightM);

  const auto guidance_stage_objects = object_array(guidance, "stages");
  const std::vector<GuidanceStageRow> guidance_rows =
    (config.explicitStagePlan || config.continueAfterTargetOrbit)
      ? guidance_rows_from_stage_objects(guidance_stage_objects)
      : std::vector<GuidanceStageRow>{};
  if (!guidance_rows.empty()) {
    config.stages = stages_from_guidance_rows(guidance_rows);
    config.throttleSchedule = throttle_schedule_from_guidance_rows(guidance_rows);
  } else {
    const auto stage_objects = object_array(request, "stages");
    if (stage_objects.empty()) {
      config.stages = default_falcon9_stages();
    } else {
    const std::vector<StageSpec> defaults = default_falcon9_stages();
    for (size_t index = 0; index < stage_objects.size(); ++index) {
      const auto& object = stage_objects[index];
      const StageSpec base = index < defaults.size() ? defaults[index] : StageSpec{};
      StageSpec stage{};
      stage.thrustVacuumN = number_value(object, "thrustVacuumN", base.thrustVacuumN);
      stage.thrustSeaLevelN = number_value(object, "thrustSeaLevelN", stage.thrustVacuumN);
      if (stage.thrustSeaLevelN == stage.thrustVacuumN) {
        stage.thrustSeaLevelN = number_value(object, "thrustSeaLevelN", base.thrustSeaLevelN);
      }
      stage.ispVacuumS = number_value(object, "ispVacuumS", base.ispVacuumS);
      stage.burnSeconds = number_value(object, "burnSeconds", base.burnSeconds);
      stage.propellantMassKg = number_value(object, "propellantMassKg", base.propellantMassKg);
      stage.dryMassKg = number_value(object, "dryMassKg", base.dryMassKg);
      stage.coastAfterSeconds = number_value(object, "coastAfterSeconds", base.coastAfterSeconds);
      config.stages.push_back(stage);
    }
    }
  }
  scale_first_stage_for_boosters(&config.stages, config.boosterMultiplier);

  if (!initial_state.empty()) {
    Vec3 position{};
    Vec3 velocity{};
    const bool has_position = number_array3(initial_state, "positionEcefM", &position);
    const bool has_velocity = number_array3(initial_state, "velocityEcefMps", &velocity);
    if (has_position && has_velocity) {
      config.hasInitialState = true;
      config.initialPositionEcefM = position;
      config.initialVelocityEcefMps = velocity;
      config.initialMassKg = number_value(initial_state, "massKg", -1.0);
      config.epochOffsetSeconds = number_value(initial_state, "epochOffsetSeconds", 0.0);
    }
  }

  return config;
}

// --- Trajectory integration ------------------------------------------------

struct LaunchTrajectoryPoint {
  Sample sample;
  double latitudeDeg = 0.0;
  double longitudeDeg = 0.0;
  double downrangeM = 0.0;
  double headingDeg = 0.0;
  Vec3 positionEcefM;
  Vec3 velocityEcefMps;
  std::string phase;
};

struct PhaseEvent {
  std::string name;
  double elapsedSeconds = 0.0;
  double altitudeM = 0.0;
  double speedMps = 0.0;
};

struct AscentResult {
  std::vector<LaunchTrajectoryPoint> points;
  std::vector<PhaseEvent> phaseEvents;
  bool secoReached = false;
  bool targetOrbitEnergyReached = false;
  bool continuedAfterTargetOrbit = false;
  bool impactReached = false;
  double targetOrbitEnergyElapsedSeconds = -1.0;
  double targetOrbitEnergyAltitudeM = 0.0;
  double targetOrbitEnergySpeedMps = 0.0;
  double gravityLossMps = 0.0;
  double dragLossMps = 0.0;
  double steeringLossMps = 0.0;
  Vec3 terminalPositionEcefM;
  Vec3 terminalVelocityEcefMps;
  double terminalMassKg = 0.0;
  double terminalElapsedSeconds = 0.0;
};

struct AscentState {
  Vec3 r;
  Vec3 v;
  double m = 0.0;
};

struct SegmentContext {
  int stageIndex = -1;  // -1 -> unpowered coast
  double stageIgnitionMassKg = 0.0;
  double propellantBudgetKg = 0.0;
  bool continueProgradeAfterTargetOrbit = false;
};

Vec3 thrust_direction(
  const AscentConfig& config,
  const SegmentContext& segment,
  double t,
  const AscentState& state
) {
  const Vec3 r_hat = normalized(state.r);
  if (segment.stageIndex <= 0) {
    // First stage: vertical rise, pitch-over kick, then zero-AoA gravity turn
    // along the ECEF (airspeed) velocity vector.
    double lat = 0.0;
    double lon = 0.0;
    double alt = 0.0;
    ecef_to_geodetic(state.r, &lat, &lon, &alt);
    Vec3 east;
    Vec3 north;
    Vec3 up;
    enu_basis(lat, lon, &east, &north, &up);
    const double azimuth = deg_to_rad(config.azimuthDeg);
    const Vec3 az_dir = east * std::sin(azimuth) + north * std::cos(azimuth);

    if (t < config.verticalRiseSeconds) {
      return up;
    }
    const double kick = deg_to_rad(config.pitchKickAngleDeg);
    const double blend = smoothstep((t - config.verticalRiseSeconds) / config.pitchOverDurationSeconds);
    if (blend < 1.0) {
      const double theta = kick * blend;
      return normalized(up * std::cos(theta) + az_dir * std::sin(theta));
    }
    const double speed = norm(state.v);
    if (speed > 30.0) {
      return normalized(state.v);
    }
    return normalized(up * std::cos(kick) + az_dir * std::sin(kick));
  }

  // Upper stage: closed-loop PD guidance on (radius, radial velocity) toward
  // a circular orbit at the target radius.  Thrust pitch is solved from the
  // commanded vertical acceleration with gravity/centripetal compensation.
  const double r_mag = norm(state.r);
  const Vec3 omega{0.0, 0.0, kEarthRotationRadS};
  const Vec3 v_inertial = state.v + cross(omega, state.r);
  if (segment.continueProgradeAfterTargetOrbit) {
    const double inertial_speed = norm(v_inertial);
    if (inertial_speed > 1.0) {
      return v_inertial * (1.0 / inertial_speed);
    }
  }
  const double vr = dot(v_inertial, r_hat);
  Vec3 v_horizontal = v_inertial - r_hat * vr;
  double vh = norm(v_horizontal);
  Vec3 h_hat;
  if (vh > 1.0) {
    h_hat = v_horizontal * (1.0 / vh);
  } else {
    double lat = 0.0;
    double lon = 0.0;
    double alt = 0.0;
    ecef_to_geodetic(state.r, &lat, &lon, &alt);
    Vec3 east;
    Vec3 north;
    Vec3 up;
    enu_basis(lat, lon, &east, &north, &up);
    const double azimuth = deg_to_rad(config.azimuthDeg);
    h_hat = normalized(east * std::sin(azimuth) + north * std::cos(azimuth));
    vh = 0.0;
  }

  const double g_local = kEarthMuM3S2 / (r_mag * r_mag);
  const double centripetal = vh * vh / r_mag;
  const double a_cmd =
    config.steerGainKp * (config.targetRadiusM - r_mag) - config.steerGainKd * vr +
    (g_local - centripetal);

  const StageSpec& stage = config.stages[static_cast<size_t>(segment.stageIndex)];
  const double thrust_accel = std::max(stage.thrustVacuumN / std::max(state.m, 1.0), 1e-6);
  double sin_pitch = a_cmd / thrust_accel;
  sin_pitch = std::max(config.minPitchSin, std::min(config.maxPitchSin, sin_pitch));
  const double cos_pitch = std::sqrt(std::max(0.0, 1.0 - sin_pitch * sin_pitch));
  return normalized(r_hat * sin_pitch + h_hat * cos_pitch);
}

struct Derivative {
  Vec3 dr;
  Vec3 dv;
  double dm = 0.0;
};

Derivative ascent_dynamics(
  const AscentConfig& config,
  const SegmentContext& segment,
  double t,
  const AscentState& state
) {
  Derivative d{};
  d.dr = state.v;
  const double r_mag = std::max(norm(state.r), 1.0);

  // Gravity (point mass) + rotating-frame terms.
  Vec3 accel = state.r * (-kEarthMuM3S2 / (r_mag * r_mag * r_mag));
  const double w = kEarthRotationRadS;
  accel.x += w * w * state.r.x + 2.0 * w * state.v.y;
  accel.y += w * w * state.r.y - 2.0 * w * state.v.x;

  double lat = 0.0;
  double lon = 0.0;
  double alt = 0.0;
  ecef_to_geodetic(state.r, &lat, &lon, &alt);

  // Drag (atmosphere co-rotates, so airspeed == ECEF speed).
  const double rho = atmosphere_density_kg_m3(config.atmosphere, alt);
  const double speed = norm(state.v);
  if (rho > 0.0 && speed > 0.1) {
    const double drag_factor =
      0.5 * rho * speed * config.dragCoefficient * config.dragAreaM2 / std::max(state.m, 1.0);
    accel = accel - state.v * drag_factor;
  }

  // Thrust.
  if (segment.stageIndex >= 0) {
    const StageSpec& stage = config.stages[static_cast<size_t>(segment.stageIndex)];
    const double prop_used = segment.stageIgnitionMassKg - state.m;
    if (prop_used < segment.propellantBudgetKg) {
      const double pressure_ratio =
        std::min(1.0, atmosphere_pressure_pa(config.atmosphere, alt) / kSeaLevelPressurePa);
      const double thrust_n =
        stage.thrustVacuumN - (stage.thrustVacuumN - stage.thrustSeaLevelN) * pressure_ratio;
      double throttle = throttle_at(config.throttleSchedule, t);
      const double sensed_limit_n = config.maxSensedAccelG * kG0 * state.m;
      if (thrust_n * throttle > sensed_limit_n) {
        throttle = sensed_limit_n / thrust_n;
      }
      const double dynamic_pressure_pa = 0.5 * rho * speed * speed;
      if (
        config.maxDynamicPressurePa > 0.0 &&
        dynamic_pressure_pa > config.maxDynamicPressurePa * 0.85
      ) {
        const double q_blend =
          (config.maxDynamicPressurePa - dynamic_pressure_pa) /
          (config.maxDynamicPressurePa * 0.15);
        throttle *= clamp01(q_blend);
      }
      throttle = std::max(0.0, throttle);
      if (throttle > 0.0) {
        const Vec3 dir = thrust_direction(config, segment, t, state);
        accel = accel + dir * (thrust_n * throttle / std::max(state.m, 1.0));
        d.dm = -stage.mdotKgS() * throttle;
      }
    }
  }

  d.dv = accel;
  return d;
}

AscentState rk4_step(
  const AscentConfig& config,
  const SegmentContext& segment,
  double t,
  const AscentState& state,
  double h
) {
  const Derivative k1 = ascent_dynamics(config, segment, t, state);
  AscentState s2{state.r + k1.dr * (h * 0.5), state.v + k1.dv * (h * 0.5), state.m + k1.dm * (h * 0.5)};
  const Derivative k2 = ascent_dynamics(config, segment, t + h * 0.5, s2);
  AscentState s3{state.r + k2.dr * (h * 0.5), state.v + k2.dv * (h * 0.5), state.m + k2.dm * (h * 0.5)};
  const Derivative k3 = ascent_dynamics(config, segment, t + h * 0.5, s3);
  AscentState s4{state.r + k3.dr * h, state.v + k3.dv * h, state.m + k3.dm * h};
  const Derivative k4 = ascent_dynamics(config, segment, t + h, s4);
  AscentState out{};
  out.r = state.r + (k1.dr + k2.dr * 2.0 + k3.dr * 2.0 + k4.dr) * (h / 6.0);
  out.v = state.v + (k1.dv + k2.dv * 2.0 + k3.dv * 2.0 + k4.dv) * (h / 6.0);
  out.m = state.m + (k1.dm + 2.0 * k2.dm + 2.0 * k3.dm + k4.dm) * (h / 6.0);
  return out;
}

double specific_orbit_energy(const AscentState& state) {
  const Vec3 omega{0.0, 0.0, kEarthRotationRadS};
  const Vec3 v_inertial = state.v + cross(omega, state.r);
  return 0.5 * dot(v_inertial, v_inertial) - kEarthMuM3S2 / std::max(norm(state.r), 1.0);
}

LaunchTrajectoryPoint make_point(
  const AscentConfig& config,
  double t,
  const AscentState& state,
  double start_lat_deg,
  double start_lon_deg,
  const std::string& phase,
  size_t index
) {
  LaunchTrajectoryPoint point{};
  double lat = 0.0;
  double lon = 0.0;
  double alt = 0.0;
  ecef_to_geodetic(state.r, &lat, &lon, &alt);
  const double speed = norm(state.v);
  point.sample.elapsedSeconds = t;
  point.sample.altitudeM = alt;
  point.sample.speedMps = speed;
  point.sample.massKg = state.m;
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
      point.headingDeg = config.azimuthDeg;
    }
  } else {
    point.sample.flightPathAngleDeg = 90.0;
    point.headingDeg = config.azimuthDeg;
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

AscentResult integrate_ascent(const AscentConfig& config) {
  AscentResult result{};
  if (config.stages.empty()) {
    return result;
  }

  AscentState state{};
  if (config.hasInitialState) {
    state.r = config.initialPositionEcefM;
    state.v = config.initialVelocityEcefMps;
  } else {
    state.r = geodetic_to_ecef(config.launchLatDeg, config.launchLonDeg, config.launchAltM);
    state.v = {0.0, 0.0, 0.0};  // ECEF frame: launch pad is at rest
  }
  double total_mass = config.payloadMassKg;
  for (const auto& stage : config.stages) {
    total_mass += stage.propellantMassKg + stage.dryMassKg;
  }
  state.m = (config.hasInitialState && config.initialMassKg > 0.0)
    ? config.initialMassKg
    : total_mass;

  double start_lat = 0.0;
  double start_lon = 0.0;
  double start_alt = 0.0;
  ecef_to_geodetic(state.r, &start_lat, &start_lon, &start_alt);

  const double t_end = config.durationSeconds;
  const double dt_target = 0.1;  // fixed internal RK4 step (<= 1 s requirement)
  const double seco_energy = -kEarthMuM3S2 / (2.0 * config.targetRadiusM);

  // Build segment timeline: powered stage 0, coast, powered stage 1, ...
  struct SegmentPlan {
    double startTime;
    double endTime;
    int stageIndex;
  };
  std::vector<SegmentPlan> plan;
  double cursor = 0.0;
  for (size_t index = 0; index < config.stages.size() && cursor < t_end; ++index) {
    const StageSpec& stage = config.stages[index];
    const double burn_end = std::min(t_end, cursor + stage.burnSeconds);
    plan.push_back({cursor, burn_end, static_cast<int>(index)});
    cursor = burn_end;
    if (stage.coastAfterSeconds > 0.0 && cursor < t_end) {
      const double coast_end = std::min(t_end, cursor + stage.coastAfterSeconds);
      plan.push_back({cursor, coast_end, -1});
      cursor = coast_end;
    }
  }
  if (cursor < t_end) {
    plan.push_back({cursor, t_end, -1});
  }

  double t = 0.0;
  size_t sample_index = 0;
  bool first_point = true;
  double next_sample_t = 0.0;
  const bool fixed_cadence = config.sampleStepSeconds > 0.0;

  result.points.push_back(make_point(config, 0.0, state, start_lat, start_lon, "liftoff", sample_index));
  ++sample_index;
  first_point = false;

  double gravity_loss = 0.0;
  double drag_loss = 0.0;
  double steering_loss = 0.0;
  bool done = false;

  auto current_phase = [&](const SegmentPlan& seg) -> std::string {
    if (first_point) {
      return "liftoff";
    }
    if (seg.stageIndex < 0) {
      return "stage-separation";
    }
    return seg.stageIndex == 0
      ? "first-stage"
      : "stage-" + std::to_string(seg.stageIndex + 1);
  };

  auto record_target_orbit_energy = [&](double event_t, const AscentState& event_state) {
    if (result.targetOrbitEnergyReached) {
      return;
    }
    double lat = 0.0;
    double lon = 0.0;
    double alt = 0.0;
    ecef_to_geodetic(event_state.r, &lat, &lon, &alt);
    result.targetOrbitEnergyReached = true;
    result.targetOrbitEnergyElapsedSeconds = event_t;
    result.targetOrbitEnergyAltitudeM = alt;
    result.targetOrbitEnergySpeedMps = norm(event_state.v);
  };

  for (size_t seg_idx = 0; seg_idx < plan.size() && !done; ++seg_idx) {
    SegmentPlan seg = plan[seg_idx];
    SegmentContext context{};
    context.stageIndex = seg.stageIndex;
    if (seg.stageIndex >= 0) {
      context.stageIgnitionMassKg = state.m;
      context.propellantBudgetKg =
        config.stages[static_cast<size_t>(seg.stageIndex)].propellantMassKg;
      if (seg.stageIndex >= 1) {
        result.phaseEvents.push_back({
          "stage" + std::to_string(seg.stageIndex + 1) + "_ignition",
          t,
          0.0,
          norm(state.v),
        });
        double lat = 0.0;
        double lon = 0.0;
        double alt = 0.0;
        ecef_to_geodetic(state.r, &lat, &lon, &alt);
        result.phaseEvents.back().altitudeM = alt;
      }
    }

    while (t < seg.endTime - 1e-9 && !done) {
      double t_target = seg.endTime;
      if (fixed_cadence) {
        while (next_sample_t <= t + 1e-9) {
          next_sample_t += config.sampleStepSeconds;
        }
        t_target = std::min(t_target, next_sample_t);
      } else {
        double lat = 0.0;
        double lon = 0.0;
        double alt = 0.0;
        ecef_to_geodetic(state.r, &lat, &lon, &alt);
        const double cadence = alt < 100000.0 ? 2.0 : 10.0;
        t_target = std::min(t_target, t + cadence);
      }

      const int substeps = std::max(1, static_cast<int>(std::ceil((t_target - t) / dt_target)));
      const double h = (t_target - t) / substeps;
      for (int step = 0; step < substeps && !done; ++step) {
        const AscentState prev = state;
        const double t_prev = t;
        context.continueProgradeAfterTargetOrbit =
          config.continueAfterTargetOrbit && result.targetOrbitEnergyReached;
        // Loss bookkeeping (reporting only; trapezoid on segment endpoints).
        const Derivative d0 = ascent_dynamics(config, context, t, state);
        state = rk4_step(config, context, t, state, h);
        t += h;

        const double speed_prev = std::max(norm(prev.v), 1e-3);
        const Vec3 r_hat = normalized(prev.r);
        const double sin_gamma = dot(prev.v, r_hat) / speed_prev;
        const double r_mag = std::max(norm(prev.r), 1.0);
        gravity_loss += (kEarthMuM3S2 / (r_mag * r_mag)) * std::max(0.0, sin_gamma) * h;
        double lat = 0.0;
        double lon = 0.0;
        double alt = 0.0;
        ecef_to_geodetic(prev.r, &lat, &lon, &alt);
        const double rho = atmosphere_density_kg_m3(config.atmosphere, alt);
        drag_loss += 0.5 * rho * speed_prev * speed_prev * config.dragCoefficient *
                     config.dragAreaM2 / std::max(prev.m, 1.0) * h;
        if (context.stageIndex >= 0 && norm(prev.v) > 10.0 && d0.dm < 0.0) {
          const Vec3 thrust_dir = thrust_direction(config, context, t_prev, prev);
          const double cos_alpha =
            std::max(-1.0, std::min(1.0, dot(thrust_dir, normalized(prev.v))));
          const StageSpec& stage = config.stages[static_cast<size_t>(context.stageIndex)];
          steering_loss +=
              (stage.thrustVacuumN / std::max(prev.m, 1.0)) * (1.0 - cos_alpha) * h;
        }

        double current_lat = 0.0;
        double current_lon = 0.0;
        double current_alt = 0.0;
        ecef_to_geodetic(state.r, &current_lat, &current_lon, &current_alt);
        if (t > 1.0 && current_alt <= 0.0) {
          const double fraction =
            alt > 0.0 ? alt / std::max(alt - current_alt, 1e-9) : 0.0;
          if (fraction > 0.0 && fraction < 1.0) {
            state = rk4_step(config, context, t_prev, prev, h * fraction);
            t = t_prev + h * fraction;
            ecef_to_geodetic(state.r, &current_lat, &current_lon, &current_alt);
          }
          result.impactReached = true;
          result.phaseEvents.push_back({
            "impact",
            t,
            std::max(0.0, current_alt),
            norm(state.v),
          });
          done = true;
          break;
        }

        // Closed-loop SECO: cut when the inertial specific orbital energy
        // reaches the target circular-orbit energy.  Refine the crossing
        // with one secant pass so the terminal state lands on the cutoff.
        if (context.stageIndex >= 1) {
          const double e_prev = specific_orbit_energy(prev);
          const double e_now = specific_orbit_energy(state);
          if (!result.targetOrbitEnergyReached && e_now >= seco_energy && e_prev < seco_energy) {
            const double fraction =
              (seco_energy - e_prev) / std::max(e_now - e_prev, 1e-9);
            const AscentState target_state = rk4_step(config, context, t_prev, prev, h * fraction);
            const double target_t = t_prev + h * fraction;
            record_target_orbit_energy(target_t, target_state);
            if (!config.continueAfterTargetOrbit) {
              state = target_state;
              t = target_t;
              result.secoReached = true;
              done = true;
            } else {
              result.continuedAfterTargetOrbit = true;
            }
          }
        }
      }

      const bool sample_due =
        done || t >= t_target - 1e-9;
      if (sample_due) {
        const bool is_terminal = done || (t >= t_end - 1e-9);
        std::string phase = current_phase(seg);
        if (result.impactReached) {
          phase = "ascent-impact";
        } else if (
          is_terminal &&
          (
            (!config.continueAfterTargetOrbit && result.secoReached) ||
            seg_idx + 1 >= plan.size()
          )
        ) {
          phase = "orbital-insertion";
        }
        result.points.push_back(
          make_point(config, t, state, start_lat, start_lon, phase, sample_index));
        ++sample_index;
        if (fixed_cadence && std::fabs(t - next_sample_t) < 1e-6) {
          next_sample_t += config.sampleStepSeconds;
        }
      }
      if (t >= t_end - 1e-9) {
        done = true;
      }
    }

    const bool segment_reached_cutoff = t >= seg.endTime - 1e-9;
    if (seg.stageIndex >= 0 && segment_reached_cutoff) {
      // Stage burnout event + jettison (dry mass and any residual propellant
      // leave with the spent stage at burnout; separation coast follows).
      const StageSpec& stage = config.stages[static_cast<size_t>(seg.stageIndex)];
      double lat = 0.0;
      double lon = 0.0;
      double alt = 0.0;
      ecef_to_geodetic(state.r, &lat, &lon, &alt);
      result.phaseEvents.push_back({
        seg.stageIndex == 0 ? "meco" : ("stage" + std::to_string(seg.stageIndex + 1) + "_cutoff"),
        t,
        alt,
        norm(state.v),
      });
      if (seg.stageIndex + 1 < static_cast<int>(config.stages.size())) {
        const double prop_used = context.stageIgnitionMassKg - state.m;
        const double residual = std::max(0.0, stage.propellantMassKg - prop_used);
        state.m = std::max(config.payloadMassKg, state.m - stage.dryMassKg - residual);
      }
    }
  }

  if (result.secoReached) {
    if (result.targetOrbitEnergyReached) {
      result.phaseEvents.push_back({
        "target_orbit_energy",
        result.targetOrbitEnergyElapsedSeconds,
        result.targetOrbitEnergyAltitudeM,
        result.targetOrbitEnergySpeedMps,
      });
    }
    double lat = 0.0;
    double lon = 0.0;
    double alt = 0.0;
    ecef_to_geodetic(state.r, &lat, &lon, &alt);
    result.phaseEvents.push_back({"seco", t, alt, norm(state.v)});
  } else if (result.targetOrbitEnergyReached) {
    result.secoReached = true;
    result.phaseEvents.push_back({
      "target_orbit_energy",
      result.targetOrbitEnergyElapsedSeconds,
      result.targetOrbitEnergyAltitudeM,
      result.targetOrbitEnergySpeedMps,
    });
    double lat = 0.0;
    double lon = 0.0;
    double alt = 0.0;
    ecef_to_geodetic(state.r, &lat, &lon, &alt);
    result.phaseEvents.push_back({"seco", t, alt, norm(state.v)});
  }

  // Guarantee a terminal sample exists at the final integration time.
  if (result.points.empty() || std::fabs(result.points.back().sample.elapsedSeconds - t) > 1e-6) {
    const std::string terminal_phase = result.impactReached
      ? "ascent-impact"
      : (result.secoReached ? "orbital-insertion" : "ascent-truncated");
    result.points.push_back(make_point(
      config,
      t,
      state,
      start_lat,
      start_lon,
      terminal_phase,
      sample_index));
  } else if (result.secoReached) {
    result.points.back().phase = "orbital-insertion";
    result.points.back().sample.id = "orbital-insertion-" + std::to_string(result.points.size() - 1);
  } else if (result.impactReached) {
    result.points.back().phase = "ascent-impact";
    result.points.back().sample.id = "ascent-impact-" + std::to_string(result.points.size() - 1);
  }
  if (!result.points.empty()) {
    result.points.front().phase = "liftoff";
    result.points.front().sample.id = "liftoff-0";
  }

  result.gravityLossMps = gravity_loss;
  result.dragLossMps = drag_loss;
  result.steeringLossMps = steering_loss;
  result.terminalPositionEcefM = state.r;
  result.terminalVelocityEcefMps = state.v;
  result.terminalMassKg = state.m;
  result.terminalElapsedSeconds = t;
  return result;
}

// --- JSON serialization ------------------------------------------------- --

double max_heading_step_deg(const std::vector<LaunchTrajectoryPoint>& points) {
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

std::string number_json(double value) {
  if (!std::isfinite(value)) {
    return "null";
  }
  char buffer[64];
  std::snprintf(buffer, sizeof(buffer), "%.12g", value);
  return buffer;
}

std::string launch_trajectory_json(const std::vector<LaunchTrajectoryPoint>& points) {
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

std::string phase_events_json(const std::vector<PhaseEvent>& events) {
  std::string output = "[";
  for (size_t index = 0; index < events.size(); ++index) {
    if (index > 0) {
      output += ",";
    }
    char buffer[512];
    std::snprintf(
      buffer,
      sizeof(buffer),
      "{\"event\":%s,\"elapsedSeconds\":%.12g,\"altitudeM\":%.12g,\"speedMps\":%.12g}",
      quote(events[index].name).c_str(),
      events[index].elapsedSeconds,
      events[index].altitudeM,
      events[index].speedMps);
    output += buffer;
  }
  output += "]";
  return output;
}

std::string terminal_state_json(const AscentResult& result, const AscentConfig& config) {
  char buffer[512];
  std::snprintf(
    buffer,
    sizeof(buffer),
    "{\"positionEcefM\":%s,\"velocityEcefMps\":%s,\"massKg\":%.12g,"
    "\"epochOffsetSeconds\":%.12g}",
    vec3_json(result.terminalPositionEcefM).c_str(),
    vec3_json(result.terminalVelocityEcefMps).c_str(),
    result.terminalMassKg,
    config.epochOffsetSeconds + result.terminalElapsedSeconds);
  return buffer;
}

std::string delta_v_json(
  const std::string& request,
  const AscentConfig& config,
  const AscentResult& result
) {
  const std::string launch_site = object_value(request, "launchSite");
  const std::string target_orbit = object_value(request, "targetOrbit");
  const double launch_lat = number_value(launch_site, "latitudeDeg", 28.608389);
  const double launch_alt = number_value(launch_site, "altitudeM", 0.0);
  const double target_alt = number_value(target_orbit, "altitudeM", 200000.0);
  const double azimuth = number_value(target_orbit, "azimuthDeg", 73.0);
  const double target_speed = result.points.empty()
    ? number_value(target_orbit, "insertionSpeedMps", 7790.0)
    : result.points.back().sample.speedMps;
  const double earth_rotation =
    kEarthRotationRadS * (kEarthMeanRadiusM + launch_alt) *
    std::cos(deg_to_rad(launch_lat)) * std::sin(deg_to_rad(azimuth));
  const double gravity_loss = result.points.empty()
    ? number_value(target_orbit, "gravityLossMps", 1500.0)
    : result.gravityLossMps;
  const double drag_loss = result.points.empty()
    ? number_value(target_orbit, "dragLossMps", 150.0)
    : result.dragLossMps;
  const double steering_loss = result.points.empty()
    ? number_value(target_orbit, "steeringLossMps", 120.0)
    : result.steeringLossMps;
  const double ideal_launch = std::max(0.0, target_speed - earth_rotation);
  const double r1 = kEarthMeanRadiusM + std::max(target_alt, 1000.0);
  const double r2 = kEarthMeanRadiusM + number_value(target_orbit, "reentryInterfaceAltitudeM", 80000.0);
  const double circular_speed = std::sqrt(kEarthMuM3S2 / r1);
  const double transfer_apogee_speed = std::sqrt(kEarthMuM3S2 * (2.0 / r1 - 2.0 / (r1 + r2)));
  const double deorbit = std::fabs(circular_speed - transfer_apogee_speed) + 25.0;

  char buffer[1024];
  std::snprintf(
    buffer,
    sizeof(buffer),
    "{\"fromStationaryLaunchMps\":%.12g,\"idealInsertionMps\":%.12g,"
    "\"earthRotationBoostMps\":%.12g,\"gravityLossMps\":%.12g,"
    "\"dragLossMps\":%.12g,\"steeringLossMps\":%.12g,"
    "\"fromStableOrbitDeorbitMps\":%.12g,"
    "\"assumptions\":[\"stationary launch site includes Earth rotation projection\","
    "\"gravity, drag, and steering losses are integrated along the simulated trajectory\","
    "\"stable orbit deorbit uses two-body transfer to entry interface plus margin\"]}",
    ideal_launch + gravity_loss + drag_loss + steering_loss,
    ideal_launch,
    earth_rotation,
    gravity_loss,
    drag_loss,
    steering_loss,
    deorbit);
  return buffer;
}

std::string achieved_orbit_json(const AscentResult& result) {
  if (result.points.empty()) {
    return "null";
  }
  const Vec3 r = result.terminalPositionEcefM;
  const Vec3 omega{0.0, 0.0, kEarthRotationRadS};
  const Vec3 v_inertial = result.terminalVelocityEcefMps + cross(omega, r);
  const double r_mag = std::max(norm(r), 1.0);
  const double speed = norm(v_inertial);
  const double energy = 0.5 * speed * speed - kEarthMuM3S2 / r_mag;
  const Vec3 h_vec = cross(r, v_inertial);
  const double h_mag = norm(h_vec);
  const Vec3 e_vec = cross(v_inertial, h_vec) * (1.0 / kEarthMuM3S2) - normalized(r);
  const double eccentricity = norm(e_vec);
  double semi_major_axis = 0.0;
  double apoapsis = 0.0;
  bool has_apoapsis = false;
  double periapsis = 0.0;
  if (energy < -1e-9) {
    semi_major_axis = -kEarthMuM3S2 / (2.0 * energy);
    apoapsis = semi_major_axis * (1.0 + eccentricity) - kEarthMeanRadiusM;
    has_apoapsis = true;
  } else if (energy > 1e-9) {
    semi_major_axis = -kEarthMuM3S2 / (2.0 * energy);
  }
  if (h_mag > 0.0) {
    const double semi_latus_rectum = (h_mag * h_mag) / kEarthMuM3S2;
    periapsis = semi_latus_rectum / std::max(1.0 + eccentricity, 1e-9) - kEarthMeanRadiusM;
  }
  const double inclination_deg =
    h_mag > 0.0 ? rad_to_deg(std::acos(std::max(-1.0, std::min(1.0, h_vec.z / h_mag)))) : 0.0;
  const double vr = dot(v_inertial, normalized(r));
  const double vt = std::sqrt(std::max(0.0, speed * speed - vr * vr));

  const std::string orbit_class = energy > 1e-9
    ? "escape"
    : (energy < -1e-9 ? "elliptic" : "parabolic");
  return
    "{\"apoapsisM\":" + (has_apoapsis ? number_json(apoapsis) : "null") +
    ",\"periapsisM\":" + number_json(periapsis) +
    ",\"semiMajorAxisM\":" + number_json(semi_major_axis) +
    ",\"eccentricity\":" + number_json(eccentricity) +
    ",\"inclinationDeg\":" + number_json(inclination_deg) +
    ",\"inertialSpeedMps\":" + number_json(speed) +
    ",\"tangentialSpeedMps\":" + number_json(vt) +
    ",\"radialSpeedMps\":" + number_json(vr) +
    ",\"specificEnergyJkg\":" + number_json(energy) +
    ",\"orbitClass\":" + quote(orbit_class) +
    ",\"earthRotationBoostMps\":" +
      number_json(kEarthRotationRadS * r_mag *
        std::sqrt(std::max(0.0, 1.0 - std::pow(r.z / r_mag, 2.0)))) +
    "}";
}

}  // namespace

extern "C" int simulate_launch_ascent(void) {
  plugin_reset_output_state();

  const std::string request = payload_for_port("ascent");
  if (request.empty()) {
    return fail("missing-ascent", "Input port \"ascent\" is required.");
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

  AscentResult ascent{};
  AscentConfig config{};
  bool generated = false;
  if (samples.empty()) {
    const std::string launch_site = object_value(request, "launchSite");
    const std::string target_orbit = object_value(request, "targetOrbit");
    const std::string initial_state = object_value(request, "initialState");
    if ((!launch_site.empty() && !target_orbit.empty()) || !initial_state.empty()) {
      config = parse_ascent_config(request, vehicle);
      ascent = integrate_ascent(config);
      generated = !ascent.points.empty();
      if (generated) {
        samples.reserve(ascent.points.size());
        for (const auto& point : ascent.points) {
          samples.push_back(point.sample);
        }
      }
    }
  }
  if (samples.empty()) {
    return fail("missing-trajectory", "Request must include samples, launchSite plus targetOrbit, or initialState.");
  }

  std::vector<HypersonicCondition> conditions;
  conditions.reserve(samples.size());
  for (const auto& sample : samples) {
    conditions.push_back(condition_for(sample, vehicle, condition_atmosphere));
  }

  size_t max_q_index = 0;
  size_t max_mach_index = 0;
  for (size_t index = 0; index < conditions.size(); ++index) {
    if (conditions[index].dynamicPressurePa > conditions[max_q_index].dynamicPressurePa) {
      max_q_index = index;
    }
    if (conditions[index].mach > conditions[max_mach_index].mach) {
      max_mach_index = index;
    }
  }

  const auto& max_q = conditions[max_q_index];
  const auto& max_mach = conditions[max_mach_index];
  const auto& first = conditions.front();
  const auto& last = conditions.back();

  char summary[2048];
  std::snprintf(
    summary,
    sizeof(summary),
    "\"maxDynamicPressure\":{\"sampleId\":%s,\"elapsedSeconds\":%.12g,\"valuePa\":%.12g},"
    "\"maxMach\":{\"sampleId\":%s,\"elapsedSeconds\":%.12g,\"value\":%.12g},"
    "\"insertionState\":{\"sampleId\":%s,\"elapsedSeconds\":%.12g,\"altitudeM\":%.12g,\"speedMps\":%.12g}",
    quote(max_q.sample.id).c_str(),
    max_q.sample.elapsedSeconds,
    max_q.dynamicPressurePa,
    quote(max_mach.sample.id).c_str(),
    max_mach.sample.elapsedSeconds,
    max_mach.mach,
    quote(last.sample.id).c_str(),
    last.sample.elapsedSeconds,
    last.sample.altitudeM,
    last.sample.speedMps);

  std::string response =
    "{\"provider\":\"launch-ascent-analysis\","
    "\"atmosphereProvider\":" + quote(atmosphere_provider) + ","
    "\"hypersonicsProvider\":" + quote(hypersonics_provider) + ","
    "\"atmosphereModel\":" + quote(atmosphere_model) + ","
    "\"status\":\"nominal\","
    "\"trajectorySource\":" + quote(generated ? "module-generated-target-orbit" : "request-samples") + "," +
    "\"hypersonicConditions\":" + join_conditions(conditions) + "," +
    std::string(summary) + ","
    "\"trajectorySamples\":" + (generated ? launch_trajectory_json(ascent.points) : "[]") + ","
	    "\"launchTrajectory\":{\"sampleCount\":" + std::to_string(samples.size()) +
	      ",\"maxHeadingStepDeg\":" + std::to_string(max_heading_step_deg(ascent.points)) +
	      ",\"secoReached\":" + (ascent.secoReached ? "true" : "false") +
	      ",\"targetOrbitEnergyReached\":" + (ascent.targetOrbitEnergyReached ? "true" : "false") +
	      ",\"continuedAfterTargetOrbit\":" + (ascent.continuedAfterTargetOrbit ? "true" : "false") +
	      ",\"impactReached\":" + (ascent.impactReached ? "true" : "false") +
	      "},"
    "\"phaseEvents\":" + (generated ? phase_events_json(ascent.phaseEvents) : "[]") + ","
    "\"terminalState\":" + (generated ? terminal_state_json(ascent, config) : "null") + ","
    "\"deltaV\":" + delta_v_json(request, config, ascent) + ","
    "\"achievedOrbit\":" + (generated ? achieved_orbit_json(ascent) : "null") + ","
    "\"events\":["
    "{\"event\":\"liftoff\",\"sampleId\":" + quote(first.sample.id) + "},"
    "{\"event\":\"max_dynamic_pressure\",\"sampleId\":" + quote(max_q.sample.id) + "},"
    "{\"event\":\"ascent_complete\",\"sampleId\":" + quote(last.sample.id) + "}"
    "],"
    "\"assumptions\":[\"RK4 3-DOF point-mass ascent integration in the rotating ECEF frame\","
    "\"thrust: vertical rise, pitch-over kick, zero-AoA gravity turn, closed-loop upper-stage PD steering to the target orbit\","
    "\"atmosphere provider composed through model selection; US76 is vacuum above its 86 km ceiling, the exponential extension above 150 km\","
    "\"hypersonic conditions computed with Sutton-Graves heating\"]}";

  return emit_json("launch", "LAM.fbs", "$LAM", response);
}
