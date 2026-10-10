// SDK method `fit`: one operator ephemeris in memory -> the SGP4 $OMM, the
// full-force HPOP $OCM, one $OBD per fit and a JSON `result` (the exact,
// reference and closure statistics, or the failure row). The ephemeris bytes
// are read, hashed and released with the invocation; nothing keeps them.
#include "space_data_module_invoke.h"

#include <cmath>
#include <exception>
#include <string>

#include "nlohmann/json.hpp"
#include "operator_fit.hpp"
#include "products.hpp"

using Json = nlohmann::json;

namespace {

int fail(const std::string& code, const std::string& message) {
  static std::string c, m;
  c = code;
  m = message;
  plugin_set_error(c.c_str(), m.c_str());
  return 1;
}

const plugin_input_frame_t* input(const char* port) {
  const int i = plugin_find_input_index(port, 0);
  return i < 0 ? nullptr : plugin_get_input_frame(static_cast<uint32_t>(i));
}

Json stats(const odhpop::ResidualStats& s) {
  return {{"n", s.n},
          {"start", odhpop::format_iso_utc(s.start, 6)},
          {"spanSeconds", s.span_s},
          {"rms3dKm", s.rms_3d_km},
          {"rmsRKm", s.rms_r_km},
          {"rmsTKm", s.rms_t_km},
          {"rmsNKm", s.rms_n_km},
          {"max3dKm", s.max_3d_km},
          {"rmsPerCoordinateKm", s.rms_per_coordinate_km}};
}

Json closure(const odhpop::ClosureResult& c) {
  if (!c.done) return {{"done", false}, {"error", c.error}};
  return {{"done", true},
          {"splitEpoch", odhpop::format_iso_utc(c.split, 6)},
          {"firstHalf", stats(c.first_half)},
          {"secondHalf", stats(c.second_half)},
          {"maxRKm", c.max_r_km},
          {"maxTKm", c.max_t_km},
          {"maxNKm", c.max_n_km}};
}

bool read_options(const plugin_input_frame_t* f, odhpop::OperatorFitOptions* o, std::string* creation, std::string* error) {
  if (!f || f->payload_length == 0) return true;
  Json j = Json::parse(f->payload, f->payload + f->payload_length, nullptr, false);
  if (j.is_discarded() || !j.is_object()) {
    *error = "options must be a JSON object";
    return false;
  }
  auto str = [&](const char* k, std::string* v) { if (j.contains(k) && j[k].is_string()) *v = j[k].get<std::string>(); };
  auto dbl = [&](const char* k, double* v) { if (j.contains(k) && j[k].is_number()) *v = j[k].get<double>(); };
  str("inputFormat", &o->input_format);
  str("dataSource", &o->data_source);
  str("objectName", &o->object_name);
  str("objectId", &o->object_id);
  if (j.contains("noradCatId") && j["noradCatId"].is_number_integer()) o->norad_cat_id = j["noradCatId"].get<int>();
  str("ommAnchor", &o->omm_anchor);
  dbl("ommStartSeconds", &o->omm_start_s);
  dbl("ommSpanSeconds", &o->omm_span_s);
  dbl("hpopSpanSeconds", &o->hpop_span_s);
  dbl("referenceRmsMaxKm", &o->reference_rms_max_km);
  dbl("hpopRmsMaxKm", &o->hpop_rms_max_km);
  if (j.contains("maximumFitPoints") && j["maximumFitPoints"].is_number_integer())
    o->maximum_fit_points = j["maximumFitPoints"].get<std::size_t>();
  if (j.contains("closure") && j["closure"].is_boolean()) o->closure = j["closure"].get<bool>();
  if (j.contains("hpop") && j["hpop"].is_boolean()) o->hpop = j["hpop"].get<bool>();
  str("creationDate", creation);
  if (j.contains("forces") && j["forces"].is_object()) {
    const Json& fj = j["forces"];
    auto& fm = o->forces;
    if (fj.contains("degree")) fm.degree = fm.order = fj["degree"].get<int>();
    if (fj.contains("oceanTideDegree")) fm.ocean_tide_degree = fj["oceanTideDegree"].get<int>();
    if (fj.contains("atmosphere")) fm.atmosphere = fj["atmosphere"].get<std::string>() == "JB2008" ? odhpop::Atmosphere::JB2008 : odhpop::Atmosphere::NRLMSISE00;
    if (fj.contains("gnssBlock")) {
      const std::string b = fj["gnssBlock"].get<std::string>();
      fm.srp_model = odhpop::SrpModel::GNSS_BOX_WING;
      fm.gnss_block = b == "GPS_IIR" ? odhpop::GnssBlock::GPS_IIR : b == "GPS_IIR_M" ? odhpop::GnssBlock::GPS_IIR_M : odhpop::GnssBlock::GPS_IIF;
      if (fj.contains("massKg")) fm.box_wing_mass_kg = fj["massKg"].get<double>();
    }
  }
  return true;
}

int push(const char* port, const char* schema, const char* id, const char* root, const std::vector<uint8_t>& bytes) {
  if (bytes.empty()) return 0;
  return plugin_push_output_ex(port, schema, id, PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, root, 0, 0, bytes.data(),
                               static_cast<uint32_t>(bytes.size())) < 0;
}

}  // namespace

extern "C" int fit(void) {
  try {
    const plugin_input_frame_t* eph = input("ephemeris");
    if (!eph || !eph->payload || eph->payload_length == 0) return fail("invalid-request", "missing ephemeris");
    odhpop::OperatorFitOptions o;
    std::string creation, error;
    if (!read_options(input("options"), &o, &creation, &error)) return fail("invalid-options", error);
    odhpop::Reference ref;
    if (const auto* f = input("reference")) {
      if (!odhpop::read_reference_omm(f->payload, f->payload_length, &ref, &error)) return fail("invalid-reference", error);
    }
    odhpop::Environment env;
    if (const auto* f = input("earth_orientation")) env.earth_orientation = f->payload, env.earth_orientation_size = f->payload_length;
    if (const auto* f = input("space_weather")) env.space_weather = f->payload, env.space_weather_size = f->payload_length;
    if (const auto* f = input("jb2008_indices")) env.jb2008_indices = f->payload, env.jb2008_indices_size = f->payload_length;
    if (const auto* f = input("kernel")) env.kernel = f->payload, env.kernel_size = f->payload_length;

    const odhpop::OperatorFitResult r = odhpop::fit_operator_ephemeris(eph->payload, eph->payload_length, ref, env, o);
    Json result = {{"ok", r.ok},
                   {"sourceSha256", r.raw_sha256},
                   {"sourceBytes", r.raw_bytes},
                   {"dataSource", o.data_source}};
    if (!r.ok) {
      // The failure row: provenance and reason only, never the bytes.
      result["failureCode"] = r.failure_code;
      result["failureMessage"] = r.failure_message;
      const std::string text = result.dump();
      return plugin_push_output_ex("result", nullptr, nullptr, PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY, nullptr, 0, 1,
                                   reinterpret_cast<const uint8_t*>(text.data()), static_cast<uint32_t>(text.size())) < 0;
    }
    result["format"] = r.format;
    result["sourceFrame"] = r.source_frame;
    result["timeSystem"] = r.time_system;
    result["objectName"] = r.object_name;
    result["objectId"] = r.object_id;
    result["noradCatId"] = r.norad_cat_id;
    result["samples"] = r.samples;
    result["first"] = odhpop::format_iso_utc(r.first, 6);
    result["last"] = odhpop::format_iso_utc(r.last, 6);
    Json segs = Json::array();
    for (const auto& s : r.segments) segs.push_back({{"begin", s.begin}, {"end", s.end}, {"evidence", s.evidence}});
    result["segments"] = segs;
    Json g = {{"epoch", odhpop::format_iso_utc(r.sgp4.epoch, 6)},
              {"fitPoints", r.sgp4.fit_points},
              {"iterations", r.sgp4.elements.iterations},
              {"converged", r.sgp4.elements.converged},
              {"criterion", "relative cost change < 1e-10"},
              {"stats", stats(r.sgp4.stats)},
              {"closure", closure(r.sgp4.closure)}};
    if (r.sgp4.has_reference) {
      g["reference"] = stats(r.sgp4.reference);
      g["referenceGate"] = r.sgp4.reference_gate_pass ? "PASS" : "FAIL";
    }
    result["sgp4"] = g;
    if (r.hpop.ok) {
      Json params = Json::object();
      for (const auto& p : r.hpop.fit.solution.params) params[odhpop::param_name(p.id)] = p.value;
      Json evidence = r.hpop.segment.evidence;
      result["hpop"] = {{"epoch", odhpop::format_iso_utc(r.hpop.fit.solution.epoch, 6)},
                        {"iterations", r.hpop.fit.iterations},
                        {"converged", r.hpop.fit.converged},
                        {"criterion", "sqrt(dx' N dx / n) < 1e-4"},
                        {"fitPoints", r.hpop.fit.fit_points},
                        {"propagations", r.hpop.fit.propagations},
                        {"weightedRms", r.hpop.fit.weighted_rms},
                        {"parameters", params},
                        {"segment", {{"begin", r.hpop.segment.begin}, {"end", r.hpop.segment.end}, {"evidence", evidence}}},
                        {"stats", stats(r.hpop.stats)},
                        {"closure", closure(r.hpop.closure)}};
    }
    const odhpop::Products p = odhpop::build_products(r, o, creation);
    if (push("omm", "OMM.fbs", "$OMM", "OMM", p.omm) || push("ocm", "OCM.fbs", "$OCM", "OCM", p.ocm) ||
        push("obd", "OBD.fbs", "$OBD", "OBD", p.obd_sgp4) || push("obd", "OBD.fbs", "$OBD", "OBD", p.obd_hpop))
      return 1;
    const std::string text = result.dump();
    return plugin_push_output_ex("result", nullptr, nullptr, PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY, nullptr, 0, 1,
                                 reinterpret_cast<const uint8_t*>(text.data()), static_cast<uint32_t>(text.size())) < 0;
  } catch (const std::exception& e) {
    return fail("fit-failed", e.what());
  }
}

// Constructors run once per resident instance: the SDK initializer and the
// WASI command CRT both request them; the build's --wrap=__wasm_call_ctors
// sends every request here (propagator/hpop's prw_sdk_adapter.cpp pattern).
extern "C" void __real___wasm_call_ctors(void);
extern "C" void __wrap___wasm_call_ctors(void) {
  static bool initialized = false;
  if (!initialized) {
    initialized = true;
    __real___wasm_call_ctors();
  }
}

// LLVM's shared-memory C++ ABI archives use these futex symbols in local
// static initialization; standard Wasm atomics implement them, so no
// Emscripten JS runtime hooks enter the artifact.
#include <cerrno>
extern "C" int emscripten_futex_wait(volatile void* address, uint32_t expected, double timeoutMs) {
  const int64_t timeout = std::isfinite(timeoutMs) ? static_cast<int64_t>(timeoutMs * 1000000.0) : -1;
  const int result = __builtin_wasm_memory_atomic_wait32(const_cast<int32_t*>(static_cast<volatile int32_t*>(address)),
                                                          static_cast<int32_t>(expected), timeout);
  return result == 0 ? 0 : result == 1 ? -EWOULDBLOCK : -ETIMEDOUT;
}
extern "C" int emscripten_futex_wake(volatile void* address, int count) {
  return __builtin_wasm_memory_atomic_notify(const_cast<int32_t*>(static_cast<volatile int32_t*>(address)), count);
}
