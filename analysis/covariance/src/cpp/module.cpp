#include <array>
#include <functional>

using namespace sdn_hypersonics;

namespace {

constexpr double kPi = 3.14159265358979323846;
constexpr double kTwoPi = 2.0 * kPi;
constexpr double kEarthMuKm3S2 = 398600.4418;

struct TleScatter {
  int sample_count = 0;
  double radial_variance_m2 = 0.0;
  double in_track_variance_m2 = 0.0;
  double cross_track_variance_m2 = 0.0;
  double velocity_variance_m2s2 = 0.0;
};

struct SensorBiasSummary {
  int count = 0;
  double radial_variance_m2 = 0.0;
  double in_track_variance_m2 = 0.0;
  double cross_track_variance_m2 = 0.0;
};

std::vector<double> number_array(const std::string& json, const std::string& key) {
  std::vector<double> values;
  const size_t key_pos = find_key(json, key);
  if (key_pos == std::string::npos) {
    return values;
  }
  const size_t open = json.find('[', key_pos);
  if (open == std::string::npos) {
    return values;
  }
  int depth = 0;
  bool in_string = false;
  bool escape = false;
  for (size_t index = open; index < json.size(); ++index) {
    const char ch = json[index];
    if (in_string) {
      if (escape) {
        escape = false;
      } else if (ch == '\\') {
        escape = true;
      } else if (ch == '"') {
        in_string = false;
      }
      continue;
    }
    if (ch == '"') {
      in_string = true;
      continue;
    }
    if (ch == '[') {
      ++depth;
      continue;
    }
    if (ch == ']') {
      --depth;
      if (depth == 0) {
        break;
      }
      continue;
    }
    if (depth != 1) {
      continue;
    }
    if ((ch >= '0' && ch <= '9') || ch == '-' || ch == '+') {
      char* end = nullptr;
      const double value = std::strtod(json.c_str() + index, &end);
      if (end != json.c_str() + index) {
        values.push_back(value);
        index = static_cast<size_t>(end - json.c_str()) - 1;
      }
    }
  }
  return values;
}

double radians(double degrees) {
  return degrees * kPi / 180.0;
}

double wrap_radians(double angle) {
  while (angle > kPi) {
    angle -= kTwoPi;
  }
  while (angle < -kPi) {
    angle += kTwoPi;
  }
  return angle;
}

double sample_variance(const std::vector<double>& values) {
  if (values.size() < 2) {
    return 0.0;
  }
  double mean = 0.0;
  for (double value : values) {
    mean += value;
  }
  mean /= static_cast<double>(values.size());
  double sum = 0.0;
  for (double value : values) {
    const double residual = value - mean;
    sum += residual * residual;
  }
  return sum / static_cast<double>(values.size() - 1);
}

TleScatter compute_tle_scatter(const std::string& request) {
  TleScatter scatter{};
  const auto entries = object_array(request, "tleSeries");
  scatter.sample_count = static_cast<int>(entries.size());
  if (entries.size() < 2) {
    return scatter;
  }

  std::vector<double> semi_major_axis_km;
  std::vector<double> inclination_rad;
  std::vector<double> raan_rad;
  std::vector<double> mean_anomaly_rad;
  semi_major_axis_km.reserve(entries.size());
  inclination_rad.reserve(entries.size());
  raan_rad.reserve(entries.size());
  mean_anomaly_rad.reserve(entries.size());

  for (const auto& entry : entries) {
    semi_major_axis_km.push_back(number_value(entry, "semiMajorAxisKm", 6778.0));
    inclination_rad.push_back(radians(number_value(entry, "inclinationDeg", 0.0)));
    raan_rad.push_back(radians(number_value(entry, "raanDeg", 0.0)));
    mean_anomaly_rad.push_back(radians(number_value(entry, "meanAnomalyDeg", 0.0)));
  }

  double mean_axis_km = 0.0;
  double mean_inclination = 0.0;
  double mean_raan = 0.0;
  double mean_anomaly = 0.0;
  for (size_t index = 0; index < entries.size(); ++index) {
    mean_axis_km += semi_major_axis_km[index];
    mean_inclination += inclination_rad[index];
    mean_raan += raan_rad[index];
    mean_anomaly += mean_anomaly_rad[index];
  }
  mean_axis_km /= static_cast<double>(entries.size());
  mean_inclination /= static_cast<double>(entries.size());
  mean_raan /= static_cast<double>(entries.size());
  mean_anomaly /= static_cast<double>(entries.size());

  std::vector<double> radial_m;
  std::vector<double> in_track_m;
  std::vector<double> cross_track_m;
  radial_m.reserve(entries.size());
  in_track_m.reserve(entries.size());
  cross_track_m.reserve(entries.size());
  const double mean_radius_m = mean_axis_km * 1000.0;
  for (size_t index = 0; index < entries.size(); ++index) {
    radial_m.push_back((semi_major_axis_km[index] - mean_axis_km) * 1000.0);
    in_track_m.push_back(mean_radius_m * wrap_radians(mean_anomaly_rad[index] - mean_anomaly));
    const double inclination_residual = inclination_rad[index] - mean_inclination;
    const double raan_residual = std::sin(std::max(0.0, mean_inclination)) *
      wrap_radians(raan_rad[index] - mean_raan);
    cross_track_m.push_back(mean_radius_m * std::hypot(inclination_residual, raan_residual));
  }

  scatter.radial_variance_m2 = sample_variance(radial_m);
  scatter.in_track_variance_m2 = sample_variance(in_track_m);
  scatter.cross_track_variance_m2 = sample_variance(cross_track_m);

  const double orbital_period_s = kTwoPi *
    std::sqrt(std::pow(std::max(mean_axis_km, 1.0), 3.0) / kEarthMuKm3S2);
  const double time_scale_s = std::max(600.0, orbital_period_s / 6.0);
  scatter.velocity_variance_m2s2 =
    (scatter.radial_variance_m2 + scatter.in_track_variance_m2 + scatter.cross_track_variance_m2) /
    (3.0 * time_scale_s * time_scale_s);
  return scatter;
}

SensorBiasSummary compute_sensor_biases(const std::string& request) {
  SensorBiasSummary summary{};
  const auto entries = object_array(request, "sensorBiases");
  summary.count = static_cast<int>(entries.size());
  for (const auto& entry : entries) {
    const double radial = number_value(entry, "radialBiasM", number_value(entry, "rangeBiasM", 0.0));
    const double in_track = number_value(entry, "inTrackBiasM", number_value(entry, "azimuthBiasM", 0.0));
    const double cross_track = number_value(entry, "crossTrackBiasM", number_value(entry, "elevationBiasM", 0.0));
    summary.radial_variance_m2 += radial * radial;
    summary.in_track_variance_m2 += in_track * in_track;
    summary.cross_track_variance_m2 += cross_track * cross_track;
  }
  return summary;
}

std::array<double, 6> direct_sigmas(const std::string& direct) {
  std::array<double, 6> sigma{};
  const std::string position = object_value(direct, "positionSigmaM");
  const std::string velocity = object_value(direct, "velocitySigmaMmps");
  sigma[0] = number_value(position, "radial", number_value(direct, "radialSigmaM", 0.0));
  sigma[1] = number_value(position, "inTrack", number_value(direct, "inTrackSigmaM", 0.0));
  sigma[2] = number_value(position, "crossTrack", number_value(direct, "crossTrackSigmaM", 0.0));
  sigma[3] = number_value(velocity, "radial", number_value(direct, "radialVelocitySigmaMmps", 0.0));
  sigma[4] = number_value(velocity, "inTrack", number_value(direct, "inTrackVelocitySigmaMmps", 0.0));
  sigma[5] = number_value(velocity, "crossTrack", number_value(direct, "crossTrackVelocitySigmaMmps", 0.0));
  return sigma;
}

std::string double_array_json(const std::vector<double>& values) {
  std::string output = "[";
  for (size_t index = 0; index < values.size(); ++index) {
    if (index > 0) {
      output += ",";
    }
    char buffer[64];
    std::snprintf(buffer, sizeof(buffer), "%.12g", values[index]);
    output += buffer;
  }
  output += "]";
  return output;
}

std::vector<double> lower_triangular_from_diagonal(const std::array<double, 6>& diagonal) {
  std::vector<double> lower;
  lower.reserve(21);
  for (int row = 0; row < 6; ++row) {
    for (int column = 0; column <= row; ++column) {
      lower.push_back(row == column ? diagonal[static_cast<size_t>(row)] : 0.0);
    }
  }
  return lower;
}

std::vector<double> position_matrix_from_diagonal(const std::array<double, 6>& diagonal) {
  return {
    diagonal[0], 0.0, 0.0,
    0.0, diagonal[1], 0.0,
    0.0, 0.0, diagonal[2],
  };
}

std::string contributors_json(
  bool has_direct,
  const TleScatter& tle,
  const SensorBiasSummary& biases
) {
  std::string output = "[";
  bool first = true;
  auto add = [&](const std::string& value) {
    if (!first) {
      output += ",";
    }
    first = false;
    output += quote(value);
  };
  if (has_direct) {
    add("direct_covariance");
  }
  if (tle.sample_count > 1) {
    add("tle_series_synthetic_mean");
  }
  if (biases.count > 0) {
    add("sensor_biases");
  }
  output += "]";
  return output;
}

std::string sigma_json(const std::array<double, 6>& diagonal) {
  char buffer[512];
  std::snprintf(
    buffer,
    sizeof(buffer),
    "{\"radial\":%.12g,\"inTrack\":%.12g,\"crossTrack\":%.12g,"
    "\"radialVelocityMmps\":%.12g,\"inTrackVelocityMmps\":%.12g,\"crossTrackVelocityMmps\":%.12g}",
    std::sqrt(std::max(0.0, diagonal[0])) * 1000.0,
    std::sqrt(std::max(0.0, diagonal[1])) * 1000.0,
    std::sqrt(std::max(0.0, diagonal[2])) * 1000.0,
    std::sqrt(std::max(0.0, diagonal[3])) * 1.0e6,
    std::sqrt(std::max(0.0, diagonal[4])) * 1.0e6,
    std::sqrt(std::max(0.0, diagonal[5])) * 1.0e6);
  return buffer;
}

std::vector<double> sorted_position_axes_m(const std::array<double, 6>& diagonal) {
  std::vector<double> axes = {
    std::sqrt(std::max(0.0, diagonal[0])) * 1000.0,
    std::sqrt(std::max(0.0, diagonal[1])) * 1000.0,
    std::sqrt(std::max(0.0, diagonal[2])) * 1000.0,
  };
  std::sort(axes.begin(), axes.end(), std::greater<double>());
  return axes;
}

}  // namespace

extern "C" int compute_covariance(void) {
  plugin_reset_output_state();

  const std::string request = payload_for_port("covariance");
  if (request.empty()) {
    return fail("missing-covariance", "Input port \"covariance\" is required.");
  }

  std::array<double, 6> diagonal{};
  const std::string direct = object_value(request, "directCovariance");
  const bool has_direct = !direct.empty();
  if (has_direct) {
    const auto lower = number_array(direct, "lowerTriangular");
    if (lower.size() == 21) {
      diagonal = {lower[0], lower[2], lower[5], lower[9], lower[14], lower[20]};
    } else {
      const auto sigma = direct_sigmas(direct);
      diagonal[0] += std::pow(sigma[0] / 1000.0, 2.0);
      diagonal[1] += std::pow(sigma[1] / 1000.0, 2.0);
      diagonal[2] += std::pow(sigma[2] / 1000.0, 2.0);
      diagonal[3] += std::pow(sigma[3] * 1.0e-6, 2.0);
      diagonal[4] += std::pow(sigma[4] * 1.0e-6, 2.0);
      diagonal[5] += std::pow(sigma[5] * 1.0e-6, 2.0);
    }
  }

  const TleScatter tle = compute_tle_scatter(request);
  diagonal[0] += tle.radial_variance_m2 * 1.0e-6;
  diagonal[1] += tle.in_track_variance_m2 * 1.0e-6;
  diagonal[2] += tle.cross_track_variance_m2 * 1.0e-6;
  diagonal[3] += tle.velocity_variance_m2s2 * 1.0e-6;
  diagonal[4] += tle.velocity_variance_m2s2 * 1.0e-6;
  diagonal[5] += tle.velocity_variance_m2s2 * 1.0e-6;

  const SensorBiasSummary biases = compute_sensor_biases(request);
  diagonal[0] += biases.radial_variance_m2 * 1.0e-6;
  diagonal[1] += biases.in_track_variance_m2 * 1.0e-6;
  diagonal[2] += biases.cross_track_variance_m2 * 1.0e-6;

  const auto lower = lower_triangular_from_diagonal(diagonal);
  const auto position = position_matrix_from_diagonal(diagonal);
  const auto axes = sorted_position_axes_m(diagonal);
  char body[4096];
  std::snprintf(
    body,
    sizeof(body),
    "{\"provider\":\"covariance-analysis\",\"status\":\"nominal\","
    "\"objectId\":%s,\"epoch\":%s,\"referenceFrame\":%s,"
    "\"inputContributors\":%s,"
    "\"positionSigmaM\":%s,"
    "\"covariance6x6LowerTriangular\":%s,"
    "\"positionCovarianceKm2\":%s,"
    "\"ellipsoid\":{\"frame\":\"RTN\",\"sigmaLevel\":1,\"semiAxesM\":%s},"
    "\"tleSeries\":{\"sampleCount\":%d,\"radialVarianceM2\":%.12g,"
    "\"inTrackVarianceM2\":%.12g,\"crossTrackVarianceM2\":%.12g},"
    "\"sensorBiases\":{\"count\":%d,\"radialVarianceM2\":%.12g,"
    "\"inTrackVarianceM2\":%.12g,\"crossTrackVarianceM2\":%.12g},"
    "\"assumptions\":[\"direct covariance is interpreted in RTN order\","
    "\"TLE-series covariance uses synthetic mean element residuals\","
    "\"sensor biases are independent one-sigma variance contributors\"]}",
    quote(string_value(request, "objectId", "UNKNOWN")).c_str(),
    quote(string_value(request, "epoch", "")).c_str(),
    quote(string_value(direct, "frame", "RTN")).c_str(),
    contributors_json(has_direct, tle, biases).c_str(),
    sigma_json(diagonal).c_str(),
    double_array_json(lower).c_str(),
    double_array_json(position).c_str(),
    double_array_json(axes).c_str(),
    tle.sample_count,
    tle.radial_variance_m2,
    tle.in_track_variance_m2,
    tle.cross_track_variance_m2,
    biases.count,
    biases.radial_variance_m2,
    biases.in_track_variance_m2,
    biases.cross_track_variance_m2);

  return emit_json("covariance", "OCM.fbs", "$OCM", body);
}
