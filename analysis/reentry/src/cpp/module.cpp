using namespace sdn_hypersonics;

namespace {

constexpr double kPi = 3.141592653589793238462643383279502884;
constexpr double kEarthMeanRadiusM = 6371008.8;
constexpr double kEarthMuM3S2 = 3.986004418e14;

struct ReentryTrajectoryPoint {
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

double normalize_heading_deg(double heading) {
  double value = std::fmod(heading, 360.0);
  if (value < 0.0) {
    value += 360.0;
  }
  return value;
}

double normalize_longitude_deg(double longitude) {
  double value = std::fmod(longitude + 540.0, 360.0);
  if (value < 0.0) {
    value += 360.0;
  }
  return value - 180.0;
}

double heading_delta_deg(double left, double right) {
  const double delta = std::fabs(normalize_heading_deg(left) - normalize_heading_deg(right));
  return std::min(delta, 360.0 - delta);
}

double angular_distance_rad(double lat1_deg, double lon1_deg, double lat2_deg, double lon2_deg) {
  const double lat1 = deg_to_rad(lat1_deg);
  const double lat2 = deg_to_rad(lat2_deg);
  const double dlat = lat2 - lat1;
  const double dlon = deg_to_rad(lon2_deg - lon1_deg);
  const double a =
    std::sin(dlat * 0.5) * std::sin(dlat * 0.5) +
    std::cos(lat1) * std::cos(lat2) * std::sin(dlon * 0.5) * std::sin(dlon * 0.5);
  return 2.0 * std::atan2(std::sqrt(a), std::sqrt(std::max(0.0, 1.0 - a)));
}

std::pair<double, double> interpolate_great_circle_deg(
  double lat1_deg,
  double lon1_deg,
  double lat2_deg,
  double lon2_deg,
  double fraction
) {
  const double u = clamp01(fraction);
  const double lat1 = deg_to_rad(lat1_deg);
  const double lon1 = deg_to_rad(lon1_deg);
  const double lat2 = deg_to_rad(lat2_deg);
  const double lon2 = deg_to_rad(lon2_deg);
  const double omega = angular_distance_rad(lat1_deg, lon1_deg, lat2_deg, lon2_deg);
  if (omega < 1.0e-12) {
    return {lat1_deg, lon1_deg};
  }
  const double sin_omega = std::sin(omega);
  const double a = std::sin((1.0 - u) * omega) / sin_omega;
  const double b = std::sin(u * omega) / sin_omega;
  const double x =
    a * std::cos(lat1) * std::cos(lon1) +
    b * std::cos(lat2) * std::cos(lon2);
  const double y =
    a * std::cos(lat1) * std::sin(lon1) +
    b * std::cos(lat2) * std::sin(lon2);
  const double z = a * std::sin(lat1) + b * std::sin(lat2);
  const double lat = std::atan2(z, std::hypot(x, y));
  const double lon = std::atan2(y, x);
  return {rad_to_deg(lat), normalize_longitude_deg(rad_to_deg(lon))};
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

std::vector<ReentryTrajectoryPoint> generate_entry_corridor(const std::string& request) {
  const std::string entry = object_value(request, "entryInterface");
  const std::string impact = object_value(request, "targetImpact");
  const std::string corridor = object_value(request, "corridor");
  if (entry.empty() || impact.empty()) {
    return {};
  }

  const double entry_lat = number_value(entry, "latitudeDeg", 26.5);
  const double entry_lon = number_value(entry, "longitudeDeg", -110.0);
  const double entry_alt = number_value(entry, "altitudeM", 80000.0);
  const double entry_speed = number_value(entry, "speedMps", 7650.0);
  const double entry_fpa = number_value(entry, "flightPathAngleDeg", -1.5);
  const double impact_lat = number_value(impact, "latitudeDeg", 29.7);
  const double impact_lon = number_value(impact, "longitudeDeg", -83.5);
  const double impact_alt = number_value(impact, "altitudeM", 0.0);
  const double duration = std::max(60.0, number_value(corridor, "durationSeconds", 1500.0));
  const double step = std::max(1.0, number_value(corridor, "sampleStepSeconds", 30.0));
  const int sample_count = std::max(2, static_cast<int>(std::ceil(duration / step)) + 1);
  const double total_downrange = angular_distance_rad(entry_lat, entry_lon, impact_lat, impact_lon) * kEarthMeanRadiusM;

  std::vector<ReentryTrajectoryPoint> points;
  points.reserve(static_cast<size_t>(sample_count));
  for (int index = 0; index < sample_count; ++index) {
    const double elapsed = std::min(duration, index * step);
    const double u = clamp01(elapsed / duration);
    const auto [lat, lon] = interpolate_great_circle_deg(entry_lat, entry_lon, impact_lat, impact_lon, u);

    ReentryTrajectoryPoint point{};
    point.sample.elapsedSeconds = elapsed;
    point.sample.altitudeM = impact_alt + std::max(0.0, entry_alt - impact_alt) * std::pow(1.0 - u, 1.35);
    point.sample.speedMps = 200.0 + std::max(0.0, entry_speed - 200.0) * std::pow(1.0 - u, 0.55);
    point.sample.massKg = number_value(object_value(request, "vehicle"), "massKg", 9500.0);
    point.sample.flightPathAngleDeg = entry_fpa - 5.0 * u;
    point.latitudeDeg = lat;
    point.longitudeDeg = lon;
    point.downrangeM = total_downrange * u;
    if (index == 0) {
      point.phase = "entry-interface";
    } else if (index == sample_count - 1) {
      point.phase = "impact";
    } else if (u < 0.45) {
      point.phase = "plasma-blackout";
    } else if (u < 0.82) {
      point.phase = "deceleration";
    } else {
      point.phase = "terminal-descent";
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

double max_heading_step_deg(const std::vector<ReentryTrajectoryPoint>& points) {
  double max_step = 0.0;
  for (size_t index = 1; index < points.size(); ++index) {
    max_step = std::max(max_step, heading_delta_deg(points[index - 1].headingDeg, points[index].headingDeg));
  }
  return max_step;
}

std::string generated_trajectory_json(const std::vector<ReentryTrajectoryPoint>& points) {
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
      "\"altitudeM\":%.12g,\"speedMps\":%.12g,\"flightPathAngleDeg\":%.12g}",
      quote(point.sample.id).c_str(),
      quote(point.phase).c_str(),
      point.sample.elapsedSeconds,
      point.latitudeDeg,
      point.longitudeDeg,
      point.downrangeM,
      point.headingDeg,
      point.sample.altitudeM,
      point.sample.speedMps,
      point.sample.flightPathAngleDeg);
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
  const Vehicle vehicle = parse_vehicle(request);
  std::vector<Sample> samples = parse_samples(request, "samples");
  const std::vector<ReentryTrajectoryPoint> generated_points =
    samples.empty() ? generate_entry_corridor(request) : std::vector<ReentryTrajectoryPoint>{};
  if (samples.empty() && !generated_points.empty()) {
    samples.reserve(generated_points.size());
    for (const auto& point : generated_points) {
      samples.push_back(point.sample);
    }
  }
  if (samples.empty()) {
    return fail("missing-trajectory", "Request must include samples or entryInterface plus targetImpact.");
  }

  std::vector<HypersonicCondition> conditions;
  conditions.reserve(samples.size());
  for (const auto& sample : samples) {
    conditions.push_back(compute_condition(sample, vehicle, atmosphere_model));
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

  std::string response =
    "{\"provider\":\"reentry-analysis\","
    "\"atmosphereProvider\":" + quote(atmosphere_provider) + ","
    "\"hypersonicsProvider\":" + quote(hypersonics_provider) + ","
    "\"atmosphereModel\":" + quote(atmosphere_model) + ","
    "\"outcome\":\"impact\","
    "\"trajectorySource\":" + quote(generated_points.empty() ? "request-samples" : "module-generated-entry-corridor") + "," +
    "\"trajectorySamples\":" + (generated_points.empty() ? trajectory_samples_json(conditions) : generated_trajectory_json(generated_points)) + "," +
    std::string(summary) + ","
    "\"impactPoint\":" + (generated_points.empty() ? std::string(impact_summary) : generated_impact_json(generated_points.back())) + ","
    "\"trajectoryGeometry\":{\"sampleCount\":" + std::to_string(samples.size()) +
      ",\"maxHeadingStepDeg\":" + std::to_string(max_heading_step_deg(generated_points)) + "},"
    "\"deltaV\":" + delta_v_json(request) + ","
    "\"hypersonicConditions\":" + join_conditions(conditions) + ","
    "\"events\":["
    "{\"event\":\"entry_interface\",\"sampleId\":" + quote(conditions.front().sample.id) + "},"
    "{\"event\":\"peak_dynamic_pressure\",\"sampleId\":" + quote(peak_q.sample.id) + "},"
    "{\"event\":\"impact\",\"sampleId\":" + quote(impact.sample.id) + "}"
    "],"
    "\"assumptions\":[\"sampled-trajectory evaluation\","
    "\"atmosphere provider composed through model selection\","
    "\"hypersonic conditions computed with Sutton-Graves heating\"]}";

  return emit_json("reentry", "REM.fbs", "$REM", response);
}
