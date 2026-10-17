// Offline Horizons evidence: all parsing of numerical epochs, time conversion,
// vector arithmetic, units and reductions live here; propagation is shipped WASM.
#include <nlohmann/json.hpp>
#include "ffm/prw_codec.h"
#include <array>
#include <fstream>
#include <iostream>
#include <sstream>
#include <stdexcept>
using Json = nlohmann::json;
using State = std::array<double, 6>;

double finite(const Json& j) {
  double x = j.get<double>();
  if (!std::isfinite(x)) throw std::runtime_error("non-finite number");
  return x;
}
double norm(const Json& a, const Json& b, int start) {
  if (a.size() != 6 || b.size() != 6) throw std::runtime_error("expected six state components");
  double sum = 0;
  for (int i = start; i < start + 3; ++i) { double d = finite(a.at(i)) - finite(b.at(i)); sum += d*d; }
  return std::sqrt(sum);
}
Json compare(const Json& in) {
  const auto& a = in.at("actual"); const auto& b = in.at("reference");
  const auto& epochs = in.at("epochs");
  if (a.empty() || a.size() != b.size() || a.size() != epochs.size()) throw std::runtime_error("state count mismatch");
  double mp = -1, mv = -1; size_t ip = 0, iv = 0;
  Json samples = Json::array();
  for (size_t i = 0; i < a.size(); ++i) {
    double p = norm(a[i], b[i], 0)*1000, v = norm(a[i], b[i], 3)*1e6;
    if (p > mp) { mp = p; ip = i; } if (v > mv) { mv = v; iv = i; }
    samples.push_back({{"utc", epochs[i]}, {"positionM", p}, {"velocityMmS", v}});
  }
  Json out = {{"sampleCount", a.size()}, {"maxPositionM", mp}, {"maxPositionKm", mp/1000},
    {"maxVelocityMmS", mv}, {"positionAtUtc", epochs[ip]}, {"velocityAtUtc", epochs[iv]},
    {"positionToleranceM", in.at("positionToleranceM")}, {"velocityToleranceMmS", in.at("velocityToleranceMmS")},
    {"met", mp < finite(in.at("positionToleranceM")) && (in.at("velocityToleranceMmS").is_null() || mv < finite(in.at("velocityToleranceMmS")))},
    {"samples", samples}};
  if (in.value("includeSubMeter", true)) out["subMeter"] = {{"toleranceM", 1}, {"met", mp < 1}};
  return out;
}

Json parse(const Json& in) {
  const std::string result = in.at("result");
  auto begin = result.find("$$SOE"), end = result.find("$$EOE");
  if (begin == std::string::npos || end == std::string::npos || end <= begin) throw std::runtime_error("missing Horizons CSV delimiters");
  std::istringstream lines(result.substr(begin + 5, end - begin - 5));
  Json rows = Json::array(); std::string line;
  double maxOffset = 0;
  while (std::getline(lines, line)) {
    if (line.find_first_not_of(" \r\t") == std::string::npos) continue;
    std::istringstream csv(line); std::string field; std::vector<std::string> fields;
    while (std::getline(csv, field, ',')) fields.push_back(field);
    if (fields.size() != 8) throw std::runtime_error("expected JD, calendar and six CSV values");
    if (rows.size() >= in.at("epochs").size()) throw std::runtime_error("too many Horizons rows");
    const std::string utc = in.at("epochs").at(rows.size());
    double whole, fraction, jd; std::string error;
    if (!ffm::parseIsoSeconds(utc, whole, fraction, jd, error)) throw std::runtime_error(error);
    ffm::TTEpoch tt;
    if (!ffm::toTT(whole, fraction, jd, timingStandard::UTC, tt, error)) throw std::runtime_error(error);
    // Split BEFORE conversion: Apple arm64 long double is binary64 too.
    // Do not subtract large JDs or add subseconds to 8e8 integral seconds.
    const auto point = fields[0].find('.');
    if (point == std::string::npos) throw std::runtime_error("expected decimal JD UTC");
    const double day = std::stod(fields[0].substr(0, point));
    const double seconds = std::stod("0" + fields[0].substr(point))*86400.0;
    const double rawWhole = (day - 2451545.0)*86400.0 + std::floor(seconds);
    const double rawFraction = seconds - std::floor(seconds);
    const double rawJD = std::stod(fields[0]);
    const double offset = (rawWhole - whole) + (rawFraction - fraction);
    if (std::abs(offset) > 0.0005) throw std::runtime_error("raw epoch is not the exported epoch rounded to 8 JD decimals");
    maxOffset = std::max(maxOffset, std::abs(offset));
    ffm::TTEpoch rawTT;
    if (!ffm::toTT(rawWhole, rawFraction, rawJD, timingStandard::UTC, rawTT, error)) throw std::runtime_error(error);
    State state; for (int i = 0; i < 6; ++i) { state[i] = std::stod(fields[i+2]); if (!std::isfinite(state[i])) throw std::runtime_error("non-finite CSV state"); }
    const double jdTdb = timesys::ttToTdb(rawTT.jdTt());
    const double nominalTdb = timesys::ttToTdb(tt.jdTt());
    rows.push_back({{"utc", utc}, {"rawJdUtcText", fields[0]}, {"rawJdUtc", rawJD},
      {"rawUtcIso", ffm::formatIsoSeconds(ffm::normalizeTT(rawWhole, rawFraction))},
      {"epochOffsetS", offset}, {"jdTdb", jdTdb}, {"nominalJdTdb", nominalTdb},
      {"etFfm", (jdTdb - 2451545.0)*86400}, {"etNominalFfm", (nominalTdb - 2451545.0)*86400},
      {"state", state}});
  }
  if (rows.size() != in.at("epochs").size()) throw std::runtime_error("missing Horizons epochs");
  return {{"rows", rows}, {"maxEpochOffsetS", maxOffset}};
}

int main() {
  try {
    Json in; std::cin >> in; Json out;
    const std::string mode = in.at("mode");
    if (mode == "parse") out = parse(in);
    else if (mode == "compare") out = compare(in);
    else if (mode == "sensitivity") {
      const double toggle = finite(in.at("toggleKm"));
      out = {{"toggleOverWithSrpResidual", toggle/finite(in.at("withSrpKm"))},
        {"toggleOverNoSrpResidual", toggle/finite(in.at("noSrpKm"))},
        {"dominatesBothResiduals", toggle > finite(in.at("withSrpKm")) && toggle > finite(in.at("noSrpKm"))}};
    } else if (mode == "parameters") {
      const double area = 21.197*14.162, mass = 6200, cr = 1.56;
      const double pressure = finite(in.at("constants").at("solarPressureAt1AuNm2"));
      const double accel = pressure*cr*area/mass;
      out = {{"areaM2", area}, {"massKg", mass}, {"cr", cr}, {"earthGmKm3S2", finite(in.at("constants").at("earthGmM3S2"))/1e9},
        {"oneAuAccelerationMS2", accel}, {"constantAcceleration24hDisplacementKm", 0.5*accel*86400*86400/1000},
        {"tenKmEquivalentConstantAccelerationMS2", 2*10000.0/(86400*86400.0)}};
    } else throw std::runtime_error("unknown mode");
    std::cout << out.dump() << '\n';
  } catch (const std::exception& e) { std::cerr << e.what() << '\n'; return 1; }
}
