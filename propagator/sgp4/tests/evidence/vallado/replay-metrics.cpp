// Vallado replay transport and scoring. All TLE/epoch/state arithmetic is
// C++; JavaScript only invokes the shipped WASM and carries JSON/FlatBuffers.
// TEME km/km/s from SGP4-VER versus WASM SI, UTC epoch, WGS-72 improved mode.
#include "SGP4.h"
#include <nlohmann/json.hpp>
#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <iostream>
#include <limits>
#include <map>
#include <set>
#include <sstream>
#include <stdexcept>
#include <vector>
using Json = nlohmann::json;
constexpr double pi = 3.14159265358979323846;
double field(const std::string& s, int start, int size) { return std::stod(s.substr(start, size)); }
double exponential(std::string s) {
  const char sign = s[0] == '-' ? '-' : '+';
  return std::stod(std::string(1, sign) + "0." + s.substr(1, 5) + "e" + s.substr(6));
}
Json omm(const std::string& a, const std::string& b) {
  const int yy = field(a, 18, 2), year = yy < 57 ? 2000 + yy : 1900 + yy;
  int mon, day, hour, minute; double sec;
  SGP4Funcs::days2mdhms_SGP4(year, field(a, 20, 3), mon, day, hour, minute, sec);
  const auto fraction = std::stoll(a.substr(24, 8));
  const auto scaled = fraction * 86400LL, whole = scaled / 100000000LL, rest = scaled % 100000000LL;
  char epoch[80];
  std::snprintf(epoch, sizeof(epoch), "%04d-%02d-%02dT%02lld:%02lld:%02lld.%08lld", year, mon, day, whole / 3600, (whole % 3600) / 60, whole % 60, rest);
  return {{"noradId", static_cast<int>(field(a, 2, 5))}, {"epoch", epoch}, {"meanMotionDot", field(a, 33, 10)},
    {"meanMotionDdot", exponential(a.substr(44, 8))}, {"bstar", exponential(a.substr(53, 8))},
    {"inclination", field(b, 8, 8)}, {"raan", field(b, 17, 8)}, {"eccentricity", std::stod("0." + b.substr(26, 7))},
    {"argPericenter", field(b, 34, 8)}, {"meanAnomaly", field(b, 43, 8)}, {"meanMotion", field(b, 52, 11)}};
}
Json prepare(const Json& in) {
  const auto a = in.at("line1").get<std::string>(), b = in.at("line2").get<std::string>();
  char s1[130] = {}, s2[130] = {};
  std::strncpy(s1, a.c_str(), 129); std::strncpy(s2, b.c_str(), 129);
  double start, stop, step; elsetrec src{};
  SGP4Funcs::twoline2rv(s1, s2, 'v', 'e', 'i', wgs72, start, stop, step, src);
  const auto o = omm(a, b);
  if (src.error) return {{"omm", o}, {"initError", src.error}};
  // Both native paths start from the identical initialized record. SGP4's
  // deep-space recurrence mutates that record as samples are evaluated.
  elsetrec effective = src;
  int year, mon, day, hour, minute; double sec, jd0, jf0;
  std::sscanf(o.at("epoch").get<std::string>().c_str(), "%d-%d-%dT%d:%d:%lf", &year, &mon, &day, &hour, &minute, &sec);
  SGP4Funcs::jday_SGP4(year, mon, day, hour, minute, sec, jd0, jf0);
  const double ommEpoch = jd0 + jf0;
  SGP4Funcs::invjday_SGP4(ommEpoch, 0, year, mon, day, hour, minute, sec);
  double jd, jf; SGP4Funcs::jday_SGP4(year, mon, day, hour, minute, sec, jd, jf);
  elsetrec module{}; char satnum[6]; std::snprintf(satnum, sizeof(satnum), "%05d", o.at("noradId").get<int>());
  const auto get = [&](const char* key) { return o.at(key).get<double>(); };
  SGP4Funcs::sgp4init(wgs72, 'i', satnum, jd + jf - 2433281.5, get("bstar"), get("meanMotionDot") * 2 * pi / (1440.0 * 1440),
    get("meanMotionDdot") * 2 * pi / (1440.0 * 1440 * 1440), get("eccentricity"), get("argPericenter") * pi / 180,
    get("inclination") * pi / 180, get("meanAnomaly") * pi / 180, get("meanMotion") * 2 * pi / 1440, get("raan") * pi / 180, module);
  module.jdsatepoch = jd; module.jdsatepochF = jf;
  // Reproduce run-vallado's original intended grid before decimal printing.
  // Fractional starts (22312) plus repeated additions can differ by a few
  // ULPs from reparsing the printed time; those are not a replay allowance.
  if (!(step > 0) || !std::isfinite(start) || !std::isfinite(stop) || !std::isfinite(step)) throw std::runtime_error("invalid TLE verification grid");
  std::vector<double> times{0.0}; double gridTime = start;
  while (gridTime <= stop) {
    if (!(gridTime == start && start == 0.0)) times.push_back(gridTime);
    gridTime += step;
  }
  if (gridTime - stop < step - 1e-6) times.push_back(stop);
  if (times.size() < in.at("rows").size()) throw std::runtime_error("printed rows exceed TLE time grid");
  Json rows = Json::array();
  std::size_t rowIndex = 0;
  for (const auto& reference : in.at("rows")) {
    const double t = times.at(rowIndex++), request = jd + jf + t / 1440;
    if (std::abs(t - reference.at("tsince").get<double>()) > 5e-9) throw std::runtime_error("printed time differs from intended TLE grid");
    const double used = (request - (jd + jf)) * 1440;
    double r[3], v[3], re[3], ve[3];
    SGP4Funcs::sgp4(src, t, r, v);
    if (src.error) throw std::runtime_error("Vallado failed at printed time");
    SGP4Funcs::sgp4(effective, used, re, ve);
    if (effective.error) throw std::runtime_error("Vallado failed at effective time");
    rows.push_back({{"tsince", t}, {"requestJd", request}, {"tsinceUsed", used}, {"timeShiftSeconds", (used - t) * 60},
      {"reference", reference}, {"source", {{"r", {r[0], r[1], r[2]}}, {"v", {v[0], v[1], v[2]}}}},
      {"effective", {{"r", {re[0], re[1], re[2]}}, {"v", {ve[0], ve[1], ve[2]}}}}});
  }
  return {{"omm", o}, {"rows", rows}, {"method", std::string(1, src.method)}};
}
Json score(const Json& in) {
  const auto& rows = in.at("prepared").at("rows"); const auto& wasm = in.at("wasm");
  if (rows.size() != wasm.size()) throw std::runtime_error("replay row count differs");
  Json result = {{"samples", Json::array()}, {"maxTimeShiftSeconds", 0.0}};
  for (const char* key : {"source", "module", "timeOnly", "wasm"}) result[key] = {{"position3dM", 0.0}, {"velocity3dMs", 0.0}};
  for (std::size_t i = 0; i < rows.size(); ++i) {
    Json sample = {{"tsince", rows[i].at("tsince")}, {"printedTsince", rows[i].at("reference").at("tsince")}, {"requestJd", rows[i].at("requestJd")},
      {"tsinceUsed", rows[i].at("tsinceUsed")}, {"timeShiftSeconds", rows[i].at("timeShiftSeconds")}};
    result["maxTimeShiftSeconds"] = std::max(result.at("maxTimeShiftSeconds").get<double>(), std::abs(sample.at("timeShiftSeconds").get<double>()));
    for (const bool velocity : {false, true}) {
      const char* axis = velocity ? "v" : "r", *wire = velocity ? "velocity" : "position", *metric = velocity ? "velocity3dMs" : "position3dM";
      double ds[3], dm[3], dt[3], dw[3];
      for (std::size_t k = 0; k < 3; ++k) {
        const double ref = rows[i].at("reference").at(axis)[k].get<double>();
        const double source = rows[i].at("source").at(axis)[k].get<double>();
        const double effective = rows[i].at("effective").at(axis)[k].get<double>();
        const double w = wasm[i].at(wire)[k].get<double>() / 1000;
        ds[k] = source - ref; dm[k] = w - effective; dt[k] = effective - source; dw[k] = w - ref;
      }
      const std::pair<const char*, const double*> differences[] = {{"source", ds}, {"module", dm}, {"timeOnly", dt}, {"wasm", dw}};
      for (const auto& [key, delta] : differences) {
        const double n = std::hypot(delta[0], delta[1], delta[2]) * 1000;
        if (!std::isfinite(n)) throw std::runtime_error("nonfinite replay difference");
        sample[key][metric] = n; result[key][metric] = std::max(result[key][metric].get<double>(), n);
      }
    }
    result["samples"].push_back(sample);
  }
  return result;
}
// JS Math.hypot and libm differ at the last few ULPs. The replay allowance
// (1 pm position, 1 pm/s velocity absolute plus 1e-12 relative) is far below
// the printed 5 um / 0.5 um/s component resolution and is solely reduction
// roundoff; there is no allowance for propagation or request changes.
Json compare(const Json& in) {
  Json failures = Json::array();
  for (const auto& key : {"source", "module", "timeOnly", "wasm"}) for (const auto& field : {"position3dM", "velocity3dMs"}) {
    const double actual = in.at("actual").at(key).at(field).get<double>(), expected = in.at("expected").at(key).at(field).get<double>();
    if (!std::isfinite(actual) || std::abs(actual - expected) > 1e-12 + 1e-12 * std::abs(expected)) failures.push_back(std::string(key) + "." + field);
  }
  const double actual = in.at("actual").at("maxTimeShiftSeconds").get<double>(), expected = in.at("expected").at("maxTimeShiftSeconds").get<double>();
  if (!std::isfinite(actual) || std::abs(actual - expected) > 1e-12 + 1e-12 * std::abs(expected)) failures.push_back("maxTimeShiftSeconds");
  return failures;
}
Json validate(const Json& in) {
  const auto& s = in.at("summary"); Json failures = Json::array(), exceeded = Json::array();
  const auto check = [&](bool passed, const std::string& message) { if (!passed) failures.push_back(message); };
  for (auto regime = s.at("tables").begin(); regime != s.at("tables").end(); ++regime) {
    Json rows = Json::array();
    for (const auto& row : s.at("sets")) if (!row.contains("initError") && (regime.key() == "all" || row.at("method") == (regime.key().find("near") == 0 ? "n" : "d"))) rows.push_back(row);
    check(regime.value().at("sets").get<std::size_t>() == rows.size(), regime.key() + ": set count differs");
    for (auto table = regime.value().begin(); table != regime.value().end(); ++table) {
      if (table.key() == "sets") continue;
      std::size_t samples = 0; double position = 0, velocity = 0;
      for (const auto& row : rows) if (row.contains(table.key())) {
        samples += row.at("rows").get<std::size_t>();
        position = std::max(position, row.at(table.key()).at("position3dM").get<double>());
        velocity = std::max(velocity, row.at(table.key()).at("velocity3dMs").get<double>());
      }
      const auto& value = table.value(); const std::string label = regime.key() + "/" + table.key();
      check(value.at("samples").get<std::size_t>() == samples, label + ": sample count differs");
      check(value.at("maxPosition3dM").get<double>() == position && value.at("maxVelocity3dMs").get<double>() == velocity, label + ": aggregate maxima differ");
      const bool miss = value.at("maxPositionComponentKm").get<double>() > s.at("printing").at("positionKm").get<double>()
        || value.at("maxVelocityComponentKms").get<double>() > s.at("printing").at("velocityKms").get<double>();
      check(miss == (value.at("samplesBeyondPrinting").get<int>() > 0), label + ": printing verdict inconsistent");
      if (miss) exceeded.push_back({{"key", table.key()}, {"label", label}});
    }
  }
  for (const std::string key : {"source", "afspc"}) {
    const auto& value = s.at("tables").at("all").at(key);
    const bool within = value.at("maxPositionComponentKm").get<double>() <= s.at("printing").at("positionKm").get<double>()
      && value.at("maxVelocityComponentKms").get<double>() <= s.at("printing").at("velocityKms").get<double>();
    check(s.at(key + "WithinPrinting").get<bool>() == within, key + ": stored printing verdict differs");
  }
  return {{"failures", failures}, {"exceeded", exceeded}};
}
double finite(const Json& value) {
  if (!value.is_number()) throw std::runtime_error("criterion value is not numeric");
  const double n = value.get<double>();
  if (!std::isfinite(n)) throw std::runtime_error("nonfinite criterion value");
  return n;
}
double nonnegative(const Json& value) {
  const double n = finite(value);
  if (n < 0) throw std::runtime_error("negative difference norm");
  return n;
}
bool reductionEqual(double actual, double expected) {
  return std::isfinite(actual) && std::isfinite(expected) && std::abs(actual - expected) <= 1e-12 + 1e-12 * std::abs(expected);
}
Json criteria(const Json& in) {
  const auto& s = in.at("summary"); const auto& blocks = in.at("blocks");
  if (!blocks.is_array() || !s.at("sets").is_array() || blocks.size() != 33 || s.at("sets").size() != 33)
    throw std::runtime_error("criteria require all 33 verification blocks, including the failed initializer");
  constexpr double positionLimitM = 0.001, velocityLimitMs = 1e-5;
  const double printR = std::sqrt(3.0) * nonnegative(s.at("printing").at("positionKm")) * 1000;
  const double printV = std::sqrt(3.0) * nonnegative(s.at("printing").at("velocityKms")) * 1000;
  Json definition = {
    {"source", {{"positionM", positionLimitM}, {"velocityMs", velocityLimitMs},
      {"rationale", "The identical pinned Vallado algorithm, WGS-72 constants and improved operation mode isolate native floating-point evaluation against the printed states. Fixed 1 mm and 10 micrometres/s agreement limits assess that evaluation; the 5 micrometre position component printing envelope is a separate diagnostic."}}},
    {"module", {{"positionM", positionLimitM}, {"velocityMs", velocityLimitMs},
      {"rationale", "The same fixed agreement limits apply to shipped WASM against native improved-mode Vallado at the same effective minutes since epoch. The elements, build, emccFast and emccStrict controlled subtractions isolate initialization and compiler arithmetic; their observed spread does not raise the limit. No printed reference rows exist at these perturbed times."}}},
    {"wasm", {{"printingNormPositionM", printR}, {"printingNormVelocityMs", printV},
      {"formula", "norm(W-P) <= norm(Veffective-Vintended) + norm(W-Veffective) + sqrt(3)*printingComponentHalfStep, evaluated independently for position and velocity at every sample"},
      {"rationale", "The per-sample bound has no acceptance epsilon. The exact vector identity is W-P=module+timeOnly+source, so the two-subtraction bound with printing alone is conditional on native-source-versus-print agreement within the printing envelope. Exceedances retain the measured source residual as their cause; the allowance is not enlarged."},
      {"noAcceptanceEpsilon", true}}}
  };
  std::set<int> indices; std::size_t propagated = 0, sampleCount = 0;
  for (const auto& block : blocks) {
    if (!block.at("index").is_number_integer()) throw std::runtime_error("noninteger block index");
    const int index = block.at("index").get<int>();
    if (index < 0 || index >= 33 || !indices.insert(index).second) throw std::runtime_error("duplicate or out-of-range block index");
    const auto& expected = s.at("sets")[index];
    if (block.at("satnum") != expected.at("satnum") || block.at("method") != expected.at("method")) throw std::runtime_error("block identity differs from summary");
    if (!block.at("samples").is_array()) throw std::runtime_error("block samples must be an array");
    if (expected.contains("initError")) {
      if (!block.at("samples").empty() || block.at("initError") != expected.at("initError")) throw std::runtime_error("failed initialization block differs");
      continue;
    }
    if (block.contains("initError") || block.at("samples").size() != expected.at("rows").get<std::size_t>()) throw std::runtime_error("propagating block row coverage differs");
    if (block.at("method") != "n" && block.at("method") != "d") throw std::runtime_error("unknown propagation regime");
    ++propagated; sampleCount += block.at("samples").size();
    for (const auto& sample : block.at("samples")) {
      for (const char* key : {"tsince", "requestJd", "tsinceUsed", "timeShiftSeconds"}) finite(sample.at(key));
      if (!reductionEqual(finite(sample.at("timeShiftSeconds")), (finite(sample.at("tsinceUsed")) - finite(sample.at("tsince"))) * 60)) throw std::runtime_error("sample time-shift decomposition differs");
      for (const char* key : {"source", "module", "timeOnly", "wasm"}) for (const char* axis : {"position3dM", "velocity3dMs"}) nonnegative(sample.at(key).at(axis));
    }
  }
  if (indices.size() != 33 || propagated != 32 || sampleCount != 666) throw std::runtime_error("criteria require 32 propagating sets and 666 scored samples");
  Json tables = Json::object(); int met = 0, scored = 0;
  for (const std::string regime : {"near-Earth (SGP4)", "deep space (SDP4)", "all"}) {
    Json table = Json::object();
    for (const char* key : {"source", "module"}) table[key] = {{"samples", 0}, {"exceeded", 0}, {"positionExceeded", 0}, {"velocityExceeded", 0}, {"maxPosition3dM", 0.0}, {"maxVelocity3dMs", 0.0}};
    int wasmSamples = 0, wasmExceeded = 0, positionExceeded = 0, velocityExceeded = 0;
    double maxR = -std::numeric_limits<double>::infinity(), maxV = -std::numeric_limits<double>::infinity(), maxTime = 0;
    Json worstR, worstV;
    for (const auto& block : blocks) {
      if (block.contains("initError") || (regime != "all" && block.at("method") != (regime.find("near") == 0 ? "n" : "d"))) continue;
      for (const auto& sample : block.at("samples")) {
        for (const char* key : {"source", "module"}) {
          auto& out = table[key]; const auto& n = sample.at(key);
          const double r = nonnegative(n.at("position3dM")), v = nonnegative(n.at("velocity3dMs"));
          out["samples"] = out.at("samples").get<int>() + 1;
          const bool rm = r > positionLimitM, vm = v > velocityLimitMs;
          out["exceeded"] = out.at("exceeded").get<int>() + (rm || vm);
          out["positionExceeded"] = out.at("positionExceeded").get<int>() + rm;
          out["velocityExceeded"] = out.at("velocityExceeded").get<int>() + vm;
          out["maxPosition3dM"] = std::max(out.at("maxPosition3dM").get<double>(), r);
          out["maxVelocity3dMs"] = std::max(out.at("maxVelocity3dMs").get<double>(), v);
        }
        // Keep this evaluation order explicit for the independent consumer.
        const double rBound = nonnegative(sample.at("timeOnly").at("position3dM")) + nonnegative(sample.at("module").at("position3dM")) + printR;
        const double vBound = nonnegative(sample.at("timeOnly").at("velocity3dMs")) + nonnegative(sample.at("module").at("velocity3dMs")) + printV;
        const double rExcess = nonnegative(sample.at("wasm").at("position3dM")) - rBound;
        const double vExcess = nonnegative(sample.at("wasm").at("velocity3dMs")) - vBound;
        ++wasmSamples; wasmExceeded += rExcess > 0 || vExcess > 0; positionExceeded += rExcess > 0; velocityExceeded += vExcess > 0;
        maxTime = std::max(maxTime, std::abs(finite(sample.at("timeShiftSeconds"))));
        Json details = sample; details["index"] = block.at("index"); details["satnum"] = block.at("satnum");
        details["positionBoundM"] = rBound; details["velocityBoundMs"] = vBound;
        details["positionExcessM"] = rExcess; details["velocityExcessMs"] = vExcess;
        if (rExcess > maxR) { maxR = rExcess; worstR = details; }
        if (vExcess > maxV) { maxV = vExcess; worstV = details; }
      }
    }
    if (!wasmSamples) throw std::runtime_error("empty primary regime");
    for (const char* key : {"source", "module"}) {
      auto& out = table[key]; const auto& expected = s.at("tables").at(regime).at(key);
      if (out.at("samples") != expected.at("samples")
          || !reductionEqual(out.at("maxPosition3dM").get<double>(), finite(expected.at("maxPosition3dM")))
          || !reductionEqual(out.at("maxVelocity3dMs").get<double>(), finite(expected.at("maxVelocity3dMs"))))
        throw std::runtime_error(regime + "/" + key + ": raw sample aggregate differs from original summary");
      out["met"] = out.at("exceeded").get<int>() == 0;
    }
    table["wasm"] = {{"met", wasmExceeded == 0}, {"samples", wasmSamples}, {"exceeded", wasmExceeded},
      {"positionExceeded", positionExceeded}, {"velocityExceeded", velocityExceeded}, {"maxPositionExcessM", maxR}, {"maxVelocityExcessMs", maxV},
      {"worstPosition", worstR}, {"worstVelocity", worstV}, {"maxAbsTimeShiftSeconds", maxTime}};
    for (const char* key : {"source", "module", "wasm"}) { ++scored; if (table.at(key).at("met").get<bool>()) ++met; }
    tables[regime] = table;
  }
  const std::set<std::string> primary = {"source", "module", "wasm"};
  const std::set<std::string> decomposition = {"afspc", "fastMath", "emccFast", "emccStrict", "elements", "build", "timeOnly"};
  int decompositionCount = 0;
  for (const auto& regime : s.at("tables")) for (auto metric = regime.begin(); metric != regime.end(); ++metric) {
    if (metric.key() == "sets" || primary.count(metric.key())) continue;
    if (!decomposition.count(metric.key())) throw std::runtime_error("unknown decomposition metric");
    ++decompositionCount;
  }
  if (scored != 9 || decompositionCount != 21) throw std::runtime_error("unexpected primary/decomposition row coverage");
  return {{"criteria", definition}, {"evidence", {{"blocks", blocks}}}, {"tables", tables},
    {"verdict", {{"scored", scored}, {"met", met}, {"missed", scored - met}, {"decomposition", decompositionCount}, {"diagnostic", 0}}}};
}
int main() {
  try { Json in; std::cin >> in; const auto mode = in.at("mode"); std::cout << (mode == "prepare" ? prepare(in) : mode == "score" ? score(in) : mode == "validate" ? validate(in) : mode == "criteria" ? criteria(in) : compare(in)).dump() << '\n'; }
  catch (const std::exception& error) { std::cerr << "Vallado replay: " << error.what() << '\n'; return 1; }
}
