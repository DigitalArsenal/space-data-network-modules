using namespace sdn_hypersonics;

namespace {

constexpr double kPi = 3.141592653589793238462643383279502884;
constexpr double kEarthMeanRadiusM = 6371008.8;
constexpr double kEarthMuM3S2 = 3.986004418e14;
constexpr double kEarthRotationRateRadS = 7.292115e-5;

struct LaunchTrajectoryPoint {
  Sample sample;
  double latitudeDeg = 0.0;
  double longitudeDeg = 0.0;
  double downrangeM = 0.0;
  double headingDeg = 0.0;
  std::string phase;
};

double deg_to_rad(double degrees) {
  return degrees * kPi / 180.0;
}

double rad_to_deg(double radians) {
  return radians * 180.0 / kPi;
}

double clamp01(double value) {
  return std::max(0.0, std::min(1.0, value));
}

double smoothstep(double value) {
  const double u = clamp01(value);
  return u * u * (3.0 - 2.0 * u);
}

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

std::pair<double, double> great_circle_point_deg(
  double start_lat_deg,
  double start_lon_deg,
  double azimuth_deg,
  double distance_m
) {
  const double lat1 = deg_to_rad(start_lat_deg);
  const double lon1 = deg_to_rad(start_lon_deg);
  const double azimuth = deg_to_rad(azimuth_deg);
  const double angular = distance_m / kEarthMeanRadiusM;
  const double sin_lat =
    std::sin(lat1) * std::cos(angular) +
    std::cos(lat1) * std::sin(angular) * std::cos(azimuth);
  const double lat2 = std::asin(std::max(-1.0, std::min(1.0, sin_lat)));
  const double y =
    std::sin(azimuth) * std::sin(angular) * std::cos(lat1);
  const double x =
    std::cos(angular) - std::sin(lat1) * std::sin(lat2);
  const double lon2 = lon1 + std::atan2(y, x);
  return {rad_to_deg(lat2), normalize_longitude_deg(rad_to_deg(lon2))};
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

std::vector<LaunchTrajectoryPoint> generate_target_orbit_trajectory(
  const std::string& request,
  const Vehicle& vehicle
) {
  const std::string launch_site = object_value(request, "launchSite");
  const std::string target_orbit = object_value(request, "targetOrbit");
  const std::string guidance = object_value(request, "guidance");
  if (launch_site.empty() || target_orbit.empty()) {
    return {};
  }

  const double launch_lat = number_value(launch_site, "latitudeDeg", 28.608389);
  const double launch_lon = number_value(launch_site, "longitudeDeg", -80.604333);
  const double launch_alt = number_value(launch_site, "altitudeM", 0.0);
  const double target_alt = number_value(target_orbit, "altitudeM", 200000.0);
  const double target_speed = number_value(
    target_orbit,
    "insertionSpeedMps",
    std::sqrt(kEarthMuM3S2 / (kEarthMeanRadiusM + std::max(target_alt, 1.0)))
  );
  const double azimuth = number_value(target_orbit, "azimuthDeg", 73.0);
  const double duration = std::max(60.0, number_value(guidance, "durationSeconds", 540.0));
  const double step = std::max(1.0, number_value(guidance, "sampleStepSeconds", 15.0));
  const int sample_count = std::max(2, static_cast<int>(std::ceil(duration / step)) + 1);
  const double final_downrange = std::max(500000.0, target_alt * 11.25);

  std::vector<LaunchTrajectoryPoint> points;
  points.reserve(static_cast<size_t>(sample_count));
  for (int index = 0; index < sample_count; ++index) {
    const double elapsed = std::min(duration, index * step);
    const double u = clamp01(elapsed / duration);
    const double downrange = final_downrange * smoothstep(u);
    const auto [lat, lon] = great_circle_point_deg(launch_lat, launch_lon, azimuth, downrange);

    LaunchTrajectoryPoint point{};
    point.sample.elapsedSeconds = elapsed;
    point.sample.altitudeM = launch_alt + std::max(0.0, target_alt - launch_alt) * std::pow(u, 1.25);
    point.sample.speedMps = target_speed * std::pow(u, 0.55);
    point.sample.massKg = std::max(vehicle.massKg * 0.08, vehicle.massKg * (1.0 - 0.82 * u));
    point.sample.flightPathAngleDeg = 0.2 + 84.8 * std::pow(1.0 - u, 1.65);
    point.latitudeDeg = lat;
    point.longitudeDeg = lon;
    point.downrangeM = downrange;
    point.headingDeg = azimuth;
    if (index == 0) {
      point.phase = "liftoff";
    } else if (index == sample_count - 1) {
      point.phase = "orbital-insertion";
    } else if (u < 0.18) {
      point.phase = "first-stage";
    } else if (u < 0.62) {
      point.phase = "second-stage";
    } else {
      point.phase = "insertion-coast";
    }
    point.sample.id = point.phase + "-" + std::to_string(index);
    points.push_back(point);
  }

  for (size_t index = 1; index < points.size(); ++index) {
    points[index - 1].headingDeg = heading_between_deg(
      points[index - 1].latitudeDeg,
      points[index - 1].longitudeDeg,
      points[index].latitudeDeg,
      points[index].longitudeDeg
    );
  }
  if (points.size() >= 2) {
    points.back().headingDeg = points[points.size() - 2].headingDeg;
  }

  return points;
}

double max_heading_step_deg(const std::vector<LaunchTrajectoryPoint>& points) {
  double max_step = 0.0;
  for (size_t index = 1; index < points.size(); ++index) {
    max_step = std::max(max_step, heading_delta_deg(points[index - 1].headingDeg, points[index].headingDeg));
  }
  return max_step;
}

std::string launch_trajectory_json(const std::vector<LaunchTrajectoryPoint>& points) {
  std::string output = "[";
  for (size_t index = 0; index < points.size(); ++index) {
    if (index > 0) {
      output += ",";
    }
    const auto& point = points[index];
    char buffer[1536];
    std::snprintf(
      buffer,
      sizeof(buffer),
      "{\"id\":%s,\"phase\":%s,\"elapsedSeconds\":%.12g,\"latitudeDeg\":%.12g,"
      "\"longitudeDeg\":%.12g,\"downrangeM\":%.12g,\"headingDeg\":%.12g,"
      "\"altitudeM\":%.12g,\"speedMps\":%.12g,\"massKg\":%.12g,"
      "\"flightPathAngleDeg\":%.12g}",
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
      point.sample.flightPathAngleDeg);
    output += buffer;
  }
  output += "]";
  return output;
}

std::string delta_v_json(const std::string& request, const std::vector<LaunchTrajectoryPoint>& points) {
  const std::string launch_site = object_value(request, "launchSite");
  const std::string target_orbit = object_value(request, "targetOrbit");
  const double launch_lat = number_value(launch_site, "latitudeDeg", 28.608389);
  const double launch_alt = number_value(launch_site, "altitudeM", 0.0);
  const double target_alt = number_value(target_orbit, "altitudeM", 200000.0);
  const double azimuth = number_value(target_orbit, "azimuthDeg", 73.0);
  const double target_speed = points.empty()
    ? number_value(target_orbit, "insertionSpeedMps", 7790.0)
    : points.back().sample.speedMps;
  const double earth_rotation =
    kEarthRotationRateRadS * (kEarthMeanRadiusM + launch_alt) *
    std::cos(deg_to_rad(launch_lat)) * std::sin(deg_to_rad(azimuth));
  const double gravity_loss = number_value(target_orbit, "gravityLossMps", 1500.0);
  const double drag_loss = number_value(target_orbit, "dragLossMps", 150.0);
  const double steering_loss = number_value(target_orbit, "steeringLossMps", 120.0);
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
    "\"launch losses are configurable engineering estimates\","
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
  const Vehicle vehicle = parse_vehicle(request);
  std::vector<Sample> samples = parse_samples(request, "samples");
  const std::vector<LaunchTrajectoryPoint> generated_points =
    samples.empty() ? generate_target_orbit_trajectory(request, vehicle) : std::vector<LaunchTrajectoryPoint>{};
  if (samples.empty() && !generated_points.empty()) {
    samples.reserve(generated_points.size());
    for (const auto& point : generated_points) {
      samples.push_back(point.sample);
    }
  }
  if (samples.empty()) {
    return fail("missing-trajectory", "Request must include samples or launchSite plus targetOrbit.");
  }

  std::vector<HypersonicCondition> conditions;
  conditions.reserve(samples.size());
  for (const auto& sample : samples) {
    conditions.push_back(compute_condition(sample, vehicle, atmosphere_model));
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
    "\"trajectorySource\":" + quote(generated_points.empty() ? "request-samples" : "module-generated-target-orbit") + "," +
    "\"hypersonicConditions\":" + join_conditions(conditions) + "," +
    std::string(summary) + ","
    "\"trajectorySamples\":" + (generated_points.empty() ? "[]" : launch_trajectory_json(generated_points)) + ","
    "\"launchTrajectory\":{\"sampleCount\":" + std::to_string(samples.size()) +
      ",\"maxHeadingStepDeg\":" + std::to_string(max_heading_step_deg(generated_points)) + "},"
    "\"deltaV\":" + delta_v_json(request, generated_points) + ","
    "\"events\":["
    "{\"event\":\"liftoff\",\"sampleId\":" + quote(first.sample.id) + "},"
    "{\"event\":\"max_dynamic_pressure\",\"sampleId\":" + quote(max_q.sample.id) + "},"
    "{\"event\":\"ascent_complete\",\"sampleId\":" + quote(last.sample.id) + "}"
    "],"
    "\"assumptions\":[\"sampled-ascent evaluation\","
    "\"atmosphere provider composed through model selection\","
    "\"hypersonic conditions computed with Sutton-Graves heating\"]}";

  return emit_json("launch", "LAM.fbs", "$LAM", response);
}
