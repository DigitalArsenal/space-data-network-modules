// Numerical reductions for the Nyx evidence scripts. Propagation stays in the
// shipped HPOP WASM; JavaScript handles files, transport and presentation only.
// Positions: SI metres in each case's GCRF/EME2000 axes, hourly UTC samples over
// the reference suite's 24 h arc. STM columns use the same axes and SI units.
#include <cmath>
#include <filesystem>
#include <iostream>
#include <stdexcept>
#include <string>
#include <nlohmann/json.hpp>

using Json = nlohmann::json;

namespace {
constexpr std::size_t propagatedSamples = 24;

double number(const Json& value) {
  if (!value.is_number()) throw std::runtime_error("expected a number");
  const double result = value.get<double>();
  if (!std::isfinite(result)) throw std::runtime_error("non-finite number");
  return result;
}

void arraySize(const Json& value, std::size_t expected, const char* what) {
  if (!value.is_array() || value.size() != expected)
    throw std::runtime_error(std::string(what) + ": expected " + std::to_string(expected) + " entries");
}

Json positions(const Json& input) {
  const auto& p = input.at("positions");
  const auto& samples = input.at("samples");
  arraySize(p, propagatedSamples, "propagated positions");
  arraySize(samples, propagatedSamples + 1, "reference samples");
  const double scale = number(input.at("scale"));
  if (scale != 1.0 && scale != 1000.0) throw std::runtime_error("position scale must be 1 or 1000");
  for (std::size_t k = 0; k < samples.size(); ++k) {
    if (!samples[k].is_array() || samples[k].size() < 4)
      throw std::runtime_error("reference sample has no time and xyz");
    if (number(samples[k][0]) != static_cast<double>(k) * 3600.0)
      throw std::runtime_error("reference samples must be hourly from 0 through 24 h");
    for (std::size_t j = 1; j <= 3; ++j) number(samples[k][j]);
  }
  double worst = -1.0, atHour = 0.0;
  for (std::size_t k = 0; k < p.size(); ++k) {
    arraySize(p[k], 3, "position");
    const double dx = number(p[k][0]) * scale - number(samples[k + 1][1]);
    const double dy = number(p[k][1]) * scale - number(samples[k + 1][2]);
    const double dz = number(p[k][2]) * scale - number(samples[k + 1][3]);
    const double difference = std::hypot(dx, dy, dz);
    if (!std::isfinite(difference)) throw std::runtime_error("non-finite position difference");
    if (difference > worst) {
      worst = difference;
      atHour = number(samples[k + 1][0]) / 3600.0;
    }
  }
  return {{"worstM", worst}, {"atHour", atHour}, {"sampleCount", p.size()}};
}

double relativeColumn(const Json& values, std::size_t dimension, std::size_t column,
                      const Json& reference, std::size_t referenceDimension,
                      std::size_t referenceColumn, std::size_t rowStart) {
  double a[3], b[3];
  for (std::size_t i = 0; i < 3; ++i) {
    a[i] = number(values[(rowStart + i) * dimension + column]);
    b[i] = number(reference[(rowStart + i) * referenceDimension + referenceColumn]);
  }
  const double difference = std::hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const double norm = std::hypot(b[0], b[1], b[2]);
  const double result = norm > 0.0 ? difference / norm : difference;
  if (!std::isfinite(result)) throw std::runtime_error("non-finite STM difference");
  return result;
}

Json stm(const Json& input) {
  const auto& samples = input.at("samples");
  const auto& references = input.at("reference");
  const auto& parameters = input.at("parameters");
  arraySize(samples, propagatedSamples, "HPOP STM samples");
  arraySize(references, propagatedSamples + 1, "Nyx STM samples");
  if (!parameters.is_array()) throw std::runtime_error("parameters must be an array");
  Json parameterWorst = Json::object();
  for (const auto& parameter : parameters) {
    arraySize(parameter, 2, "parameter name and reference key");
    parameterWorst[parameter[0].get<std::string>()] = 0.0;
  }
  double worst = 0.0;
  std::size_t worstAt = 0;
  for (std::size_t k = 0; k < samples.size(); ++k) {
    const auto& matrix = samples[k].at("STM");
    const auto dimension = matrix.at("DIMENSION").get<std::size_t>();
    if (dimension != 6 + parameters.size()) throw std::runtime_error("HPOP STM dimension differs from parameter count");
    const auto& values = matrix.at("VALUES");
    arraySize(values, dimension * dimension, "HPOP STM values");
    for (const auto& value : values) number(value);
    const auto& reference = references[k + 1];
    arraySize(reference.at("phi"), 36, "Nyx orbit STM");
    for (std::size_t column = 0; column < 6; ++column) {
      for (const std::size_t rowStart : {0u, 3u}) {
        const double difference = relativeColumn(values, dimension, column, reference.at("phi"), 6, column, rowStart);
        if (difference > worst) {
          worst = difference;
          worstAt = k + 1;
        }
      }
    }
    for (std::size_t q = 0; q < parameters.size(); ++q) {
      const auto name = parameters[q][0].get<std::string>();
      const auto key = parameters[q][1].get<std::string>();
      const auto& column = reference.at(key);
      arraySize(column, 6, "Nyx parameter column");
      for (const std::size_t rowStart : {0u, 3u}) {
        const double difference = relativeColumn(values, dimension, 6 + q, column, 1, 0, rowStart);
        if (difference > parameterWorst[name].get<double>()) parameterWorst[name] = difference;
      }
    }
  }
  Json result = {{"worst", worst}, {"atHour", worstAt}, {"sampleCount", samples.size()}};
  if (!parameters.empty()) result["parameters"] = parameterWorst;
  return result;
}

// Serialize the exported SI inputs for the existing Nyx runner. These modes
// only convert units; the runner retains all atmosphere/orbit calculations.
Json nyxDragInput(const Json& input) {
  const auto& source = input.at("casesExport");
  const auto& constants = source.at("constants");
  const auto& weather = source.at("spaceWeather").at("constant");
  const std::filesystem::path scratch(input.at("scratch").get<std::string>());
  const std::filesystem::path repo(input.at("repo").get<std::string>());
  Json cases = Json::array();
  for (const auto& c : source.at("cases")) {
    const auto& forces = c.at("forces");
    const auto& drag = forces.at("drag");
    if (drag.is_null() || drag.at("atmosphere") != "NRLMSISE00" || !forces.at("solidTides").is_null()
        || !forces.at("oceanTides").is_null() || !forces.at("earthRadiation").is_null()) continue;
    if (c.at("frame") != "GCRF") throw std::runtime_error("drag diagnostic only accepts GCRF cases");
    Json state = Json::array();
    for (const char* key : {"positionM", "velocityMS"}) {
      const auto& vector = c.at("initialState").at(key);
      arraySize(vector, 3, "initial state vector");
      for (const auto& component : vector) state.push_back(number(component) / 1000.0);
    }
    Json field = nullptr;
    if (!forces.at("gravityField").is_null()) {
      const auto& f = forces.at("gravityField");
      std::string name = f.at("model").get<std::string>() + "-" + std::to_string(f.at("degree").get<int>())
        + "x" + std::to_string(f.at("order").get<int>());
      if (f.contains("tesseralDegree")) name += "t" + std::to_string(f.at("tesseralDegree").get<int>());
      field = {{"cof", (scratch / "work" / (name + ".cof")).string()}, {"degree", f.at("degree")},
        {"order", f.at("order")}, {"radiusKm", number(f.at("radiusM")) / 1000.0}};
    }
    Json srp = nullptr;
    if (!forces.at("solarRadiationPressure").is_null()) {
      const auto& s = forces.at("solarRadiationPressure");
      srp = {{"cr", s.at("cr")}, {"areaM2", s.at("areaM2")}};
    }
    const Json drivers = drag.at("spaceWeather") == "cssi"
      ? Json{{"csv", (scratch / "work" / "cssi.csv").string()}}
      : Json{{"f107", weather.at("f107")}, {"ap", weather.at("ap")}, {"kp", weather.at("kp")}};
    cases.push_back({{"id", c.at("id")}, {"state", state}, {"epochs", c.at("sampleEpochsUtc")},
      {"offsets", c.at("sampleOffsetsS")}, {"massKg", constants.at("spacecraft").at("massKg")},
      {"field", field}, {"thirdBodies", !forces.at("thirdBodies").empty()}, {"srp", srp},
      {"drag", {{"cd", drag.at("cd")}, {"areaM2", drag.at("areaM2")},
        {"rateM2KgS", drag.value("areaOverMassRateM2KgS", Json(nullptr))}, {"weather", drivers}}},
      {"inTrackMS2", forces.at("inTrackAccelerationMS2")}, {"relativity", forces.at("relativity")}, {"stm", false}});
  }
  if (cases.size() != 8) throw std::runtime_error("expected eight supported drag cases");
  return {{"mode", "propagate"}, {"kernel", (repo / source.at("models").at("ephemeris").at("path").get<std::string>()).string()},
    {"pca", (scratch / "data" / "pck08.pca").string()}, {"bpc", (scratch / "data" / "hpop-itrf-2026-08.bpc").string()},
    {"gmKm3S2", number(constants.at("earthGmM3S2")) / 1e9},
    {"occultingRadiusKm", number(constants.at("shadowBodyRadiusM")) / 1000.0},
    {"sunRadiusKm", number(constants.at("sunRadiusM")) / 1000.0},
    {"sunGmKm3S2", number(constants.at("sunGmM3S2")) / 1e9},
    {"moonGmKm3S2", number(constants.at("moonGmM3S2")) / 1e9},
    {"fluxWm2", constants.at("solarIrradianceAt1AuWM2")}, {"tolerance", 1e-13}, {"maxStepS", 30}, {"cases", cases}};
}

Json nyxSamplesSi(const Json& input) {
  Json cases = Json::array();
  for (const auto& c : input.at("cases")) {
    Json samples = Json::array();
    arraySize(c.at("samples"), propagatedSamples + 1, "Nyx samples");
    for (const auto& sample : c.at("samples")) {
      arraySize(sample, 7, "Nyx time and state sample");
      Json converted = Json::array({number(sample[0])});
      for (std::size_t i = 1; i < 7; ++i) converted.push_back(number(sample[i]) * 1000.0);
      samples.push_back(converted);
    }
    cases.push_back({{"id", c.at("id")}, {"samples", samples}});
  }
  return {{"cases", cases}};
}
}  // namespace

int main() {
  try {
    Json input;
    std::cin >> input;
    const auto mode = input.at("mode").get<std::string>();
    const Json result = mode == "positions" ? positions(input) : mode == "stm" ? stm(input)
      : mode == "nyx-drag-input" ? nyxDragInput(input) : mode == "nyx-samples-si" ? nyxSamplesSi(input)
      : throw std::runtime_error("unknown score mode: " + mode);
    std::cout << result.dump() << '\n';
    return 0;
  } catch (const std::exception& error) {
    std::cerr << "Nyx score metrics: " << error.what() << '\n';
    return 1;
  }
}
