#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <vector>

#include "space_data_module_invoke.h"

namespace sdn_hypersonics {

constexpr double kGamma = 1.4;
constexpr double kGasConstant = 287.05287;
constexpr double kGravityMps2 = 9.80665;

struct AtmosphereState {
  double densityKgM3 = 0.0;
  double temperatureK = 288.15;
  double pressurePa = 101325.0;
  double soundSpeedMps = 340.294;
};

struct Sample {
  std::string id;
  double elapsedSeconds = 0.0;
  double altitudeM = 0.0;
  double speedMps = 0.0;
  double massKg = 0.0;
  double flightPathAngleDeg = 0.0;
};

struct Vehicle {
  double referenceAreaM2 = 1.0;
  double referenceLengthM = 1.0;
  double noseRadiusM = 0.5;
  double massKg = 1000.0;
};

struct HypersonicCondition {
  Sample sample;
  AtmosphereState atmosphere;
  double mach = 0.0;
  double dynamicPressurePa = 0.0;
  double stagnationHeatFluxWm2 = 0.0;
  double reynoldsNumber = 0.0;
  double loadFactorG = 0.0;
};

std::string json_escape(const std::string& input) {
  std::string escaped;
  escaped.reserve(input.size() + 8);
  for (char ch : input) {
    if (ch == '"' || ch == '\\') {
      escaped.push_back('\\');
    }
    escaped.push_back(ch);
  }
  return escaped;
}

std::string quote(const std::string& input) {
  return "\"" + json_escape(input) + "\"";
}

size_t find_key(const std::string& json, const std::string& key, size_t offset = 0) {
  return json.find("\"" + key + "\"", offset);
}

double number_value(
  const std::string& json,
  const std::string& key,
  double fallback,
  size_t offset = 0
) {
  const size_t key_pos = find_key(json, key, offset);
  if (key_pos == std::string::npos) {
    return fallback;
  }
  const size_t colon = json.find(':', key_pos);
  if (colon == std::string::npos) {
    return fallback;
  }
  const char* start = json.c_str() + colon + 1;
  char* end = nullptr;
  const double value = std::strtod(start, &end);
  return end == start ? fallback : value;
}

std::string string_value(
  const std::string& json,
  const std::string& key,
  const std::string& fallback,
  size_t offset = 0
) {
  const size_t key_pos = find_key(json, key, offset);
  if (key_pos == std::string::npos) {
    return fallback;
  }
  const size_t colon = json.find(':', key_pos);
  if (colon == std::string::npos) {
    return fallback;
  }
  const size_t open = json.find('"', colon + 1);
  if (open == std::string::npos) {
    return fallback;
  }
  std::string result;
  for (size_t index = open + 1; index < json.size(); ++index) {
    const char ch = json[index];
    if (ch == '\\' && index + 1 < json.size()) {
      result.push_back(json[index + 1]);
      ++index;
      continue;
    }
    if (ch == '"') {
      return result;
    }
    result.push_back(ch);
  }
  return fallback;
}

std::vector<std::string> object_array(const std::string& json, const std::string& key) {
  std::vector<std::string> objects;
  const size_t key_pos = find_key(json, key);
  if (key_pos == std::string::npos) {
    return objects;
  }
  const size_t array_open = json.find('[', key_pos);
  if (array_open == std::string::npos) {
    return objects;
  }

  int array_depth = 0;
  int object_depth = 0;
  bool in_string = false;
  bool escape = false;
  size_t object_start = std::string::npos;

  for (size_t index = array_open; index < json.size(); ++index) {
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
      ++array_depth;
      continue;
    }
    if (ch == ']') {
      --array_depth;
      if (array_depth == 0) {
        break;
      }
      continue;
    }
    if (array_depth != 1) {
      continue;
    }
    if (ch == '{') {
      if (object_depth == 0) {
        object_start = index;
      }
      ++object_depth;
      continue;
    }
    if (ch == '}') {
      --object_depth;
      if (object_depth == 0 && object_start != std::string::npos) {
        objects.push_back(json.substr(object_start, index - object_start + 1));
        object_start = std::string::npos;
      }
    }
  }

  return objects;
}

std::string object_value(const std::string& json, const std::string& key) {
  const size_t key_pos = find_key(json, key);
  if (key_pos == std::string::npos) {
    return "";
  }
  const size_t object_open = json.find('{', key_pos);
  if (object_open == std::string::npos) {
    return "";
  }

  int object_depth = 0;
  bool in_string = false;
  bool escape = false;
  for (size_t index = object_open; index < json.size(); ++index) {
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
    if (ch == '{') {
      ++object_depth;
      continue;
    }
    if (ch == '}') {
      --object_depth;
      if (object_depth == 0) {
        return json.substr(object_open, index - object_open + 1);
      }
    }
  }

  return "";
}

std::vector<Sample> parse_samples(const std::string& request, const std::string& key) {
  std::vector<Sample> samples;
  const auto objects = object_array(request, key);
  samples.reserve(objects.size());
  for (size_t index = 0; index < objects.size(); ++index) {
    const auto& object = objects[index];
    Sample sample{};
    sample.id = string_value(object, "id", "sample-" + std::to_string(index));
    sample.elapsedSeconds = number_value(object, "elapsedSeconds", 0.0);
    sample.altitudeM = number_value(object, "altitudeM", 0.0);
    sample.speedMps = number_value(object, "speedMps", 0.0);
    sample.massKg = number_value(object, "massKg", 0.0);
    sample.flightPathAngleDeg = number_value(object, "flightPathAngleDeg", 0.0);
    samples.push_back(sample);
  }
  return samples;
}

Vehicle parse_vehicle(const std::string& request) {
  Vehicle vehicle{};
  vehicle.referenceAreaM2 = number_value(request, "referenceAreaM2", vehicle.referenceAreaM2);
  vehicle.referenceLengthM = number_value(request, "referenceLengthM", vehicle.referenceLengthM);
  vehicle.noseRadiusM = number_value(request, "noseRadiusM", vehicle.noseRadiusM);
  vehicle.massKg = number_value(request, "massKg", vehicle.massKg);
  return vehicle;
}

AtmosphereState us76(double altitude_m) {
  const double h = std::clamp(altitude_m, 0.0, 84852.0);
  static const double base_h[] = {0.0, 11000.0, 20000.0, 32000.0, 47000.0, 51000.0, 71000.0};
  static const double base_t[] = {288.15, 216.65, 216.65, 228.65, 270.65, 270.65, 214.65};
  static const double base_p[] = {
    101325.0,
    22632.0639734629,
    5474.88866967778,
    868.018684755227,
    110.906305554965,
    66.9388731186873,
    3.95642042804073
  };
  static const double lapse[] = {-0.0065, 0.0, 0.001, 0.0028, 0.0, -0.0028, -0.002};

  size_t layer = 0;
  for (size_t index = 1; index < 7; ++index) {
    if (h >= base_h[index]) {
      layer = index;
    }
  }

  const double dh = h - base_h[layer];
  const double t0 = base_t[layer];
  const double p0 = base_p[layer];
  const double l = lapse[layer];
  const double temperature = t0 + l * dh;
  double pressure = p0;
  if (std::abs(l) < 1.0e-12) {
    pressure = p0 * std::exp(-kGravityMps2 * dh / (kGasConstant * t0));
  } else {
    pressure = p0 * std::pow(t0 / temperature, kGravityMps2 / (kGasConstant * l));
  }

  AtmosphereState state{};
  state.temperatureK = temperature;
  state.pressurePa = pressure;
  state.densityKgM3 = pressure / (kGasConstant * temperature);
  state.soundSpeedMps = std::sqrt(kGamma * kGasConstant * temperature);
  return state;
}

AtmosphereState atmosphere_for_model(double altitude_m, const std::string& model) {
  if (model == "NRLMSISE00") {
    const double clamped = std::min(altitude_m, 86000.0);
    AtmosphereState base = us76(clamped);
    if (altitude_m > 86000.0) {
      const double scale_height_m = 28000.0;
      base.temperatureK = 900.0;
      base.densityKgM3 *= std::exp(-(altitude_m - 86000.0) / scale_height_m);
      base.pressurePa = base.densityKgM3 * kGasConstant * base.temperatureK;
      base.soundSpeedMps = std::sqrt(kGamma * kGasConstant * base.temperatureK);
    }
    return base;
  }
  return us76(altitude_m);
}

double dynamic_viscosity_pa_s(double temperature_k) {
  return 1.458e-6 * std::pow(temperature_k, 1.5) / (temperature_k + 110.4);
}

HypersonicCondition compute_condition(
  const Sample& sample,
  const Vehicle& vehicle,
  const std::string& atmosphere_model
) {
  HypersonicCondition condition{};
  condition.sample = sample;
  condition.atmosphere = atmosphere_for_model(sample.altitudeM, atmosphere_model);
  condition.mach = condition.atmosphere.soundSpeedMps > 0.0
    ? sample.speedMps / condition.atmosphere.soundSpeedMps
    : 0.0;
  condition.dynamicPressurePa =
    0.5 * condition.atmosphere.densityKgM3 * sample.speedMps * sample.speedMps;
  const double nose_radius_m = std::max(vehicle.noseRadiusM, 0.01);
  condition.stagnationHeatFluxWm2 =
    1.83e-4 * std::sqrt(std::max(condition.atmosphere.densityKgM3, 0.0) / nose_radius_m) *
    sample.speedMps * sample.speedMps * sample.speedMps;
  const double mu = dynamic_viscosity_pa_s(condition.atmosphere.temperatureK);
  condition.reynoldsNumber =
    mu > 0.0
      ? condition.atmosphere.densityKgM3 * sample.speedMps *
          std::max(vehicle.referenceLengthM, 0.01) / mu
      : 0.0;
  const double mass_kg = sample.massKg > 0.0 ? sample.massKg : vehicle.massKg;
  condition.loadFactorG =
    mass_kg > 0.0
      ? condition.dynamicPressurePa * vehicle.referenceAreaM2 / (mass_kg * kGravityMps2)
      : 0.0;
  return condition;
}

std::string atmosphere_json(const AtmosphereState& state) {
  char buffer[512];
  std::snprintf(
    buffer,
    sizeof(buffer),
    "{\"densityKgM3\":%.12g,\"temperatureK\":%.12g,\"pressurePa\":%.12g,\"soundSpeedMps\":%.12g}",
    state.densityKgM3,
    state.temperatureK,
    state.pressurePa,
    state.soundSpeedMps);
  return buffer;
}

std::string condition_json(const HypersonicCondition& condition) {
  char buffer[1536];
  std::snprintf(
    buffer,
    sizeof(buffer),
    "{\"id\":%s,\"elapsedSeconds\":%.12g,\"altitudeM\":%.12g,\"speedMps\":%.12g,"
    "\"mach\":%.12g,\"dynamicPressurePa\":%.12g,\"stagnationHeatFluxWm2\":%.12g,"
    "\"reynoldsNumber\":%.12g,\"loadFactorG\":%.12g,\"atmosphere\":%s}",
    quote(condition.sample.id).c_str(),
    condition.sample.elapsedSeconds,
    condition.sample.altitudeM,
    condition.sample.speedMps,
    condition.mach,
    condition.dynamicPressurePa,
    condition.stagnationHeatFluxWm2,
    condition.reynoldsNumber,
    condition.loadFactorG,
    atmosphere_json(condition.atmosphere).c_str());
  return buffer;
}

std::string join_conditions(const std::vector<HypersonicCondition>& conditions) {
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

std::string payload_for_port(const char* port_id) {
  const int32_t index = plugin_find_input_index(port_id, 0);
  if (index < 0) {
    return "";
  }
  const plugin_input_frame_t* frame = plugin_get_input_frame(static_cast<uint32_t>(index));
  if (!frame || !frame->payload || frame->payload_length == 0) {
    return "";
  }
  return std::string(reinterpret_cast<const char*>(frame->payload), frame->payload_length);
}

int emit_json(const char* port_id, const char* schema_name, const char* file_identifier, const std::string& json) {
  const auto* payload = reinterpret_cast<const uint8_t*>(json.data());
  if (plugin_push_output(port_id, schema_name, file_identifier, payload, static_cast<uint32_t>(json.size())) < 0) {
    plugin_set_error("emit-failed", "Failed to emit module response.");
    return 1;
  }
  return 0;
}

int fail(const char* code, const char* message) {
  plugin_set_error(code, message);
  return 1;
}

}  // namespace sdn_hypersonics
