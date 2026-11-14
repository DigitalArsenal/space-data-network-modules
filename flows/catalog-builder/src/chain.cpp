#undef plugin_get_input_count
#undef plugin_get_input_frame
#undef plugin_reset_output_state
#undef plugin_push_output
#undef plugin_set_error

namespace catalog_chain {
static int emit(const char* port, const char* code, const std::vector<uint8_t>& bytes) {
  const std::string schema = std::string(code) + ".fbs", identifier = std::string("$") + code;
  return plugin_push_output_ex(port, schema.c_str(), identifier.c_str(), PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER,
                              code, 0, 0, bytes.data(), bytes.size()) < 0 ? 500 : 0;
}
static int finish(int status, const std::vector<uint8_t>& fallback, const std::vector<uint8_t>& candidate = {}) {
  catalog_wire::QRPT outcome;
  outcome.KIND = status == 0 ? catalog_wire::qrpKind::Page : catalog_wire::qrpKind::Error;
  outcome.STATUS = status == 0 ? catalog_wire::qrpStatus::Ok : catalog_wire::qrpStatus::Error;
  outcome.SCHEMA_NAME = "OCM.fbs";
  outcome.ERROR_CODE = error_code;
  outcome.MESSAGE = error_message;
  outcome.HTTP_STATUS = status == 0 ? 200 : 422;
  outcome.RECORD_COUNT = candidate.empty() ? 0 : 1;
  flatbuffers::FlatBufferBuilder b;
  catalog_wire::FinishQRPBuffer(b, catalog_wire::QRP::Pack(b, &outcome));
  std::vector<uint8_t> decision(b.GetBufferPointer(), b.GetBufferPointer() + b.GetSize());
  inputs.clear(); reset(); plugin_reset_output_state();
  if (!fallback.empty() && emit("fallback", "OCM", fallback)) return 500;
  if (status == 0 && !candidate.empty() && emit("elements", "OCM", candidate)) return 500;
  return emit("decision", "QRP", decision);
}
}

extern "C" int run_chain() {
  using namespace catalog_chain;
  inputs.clear(); reset();
  const plugin_input_frame_t *seed = nullptr, *flight = nullptr, *policy = nullptr, *weather = nullptr;
  for (uint32_t i = 0; i < plugin_get_input_count(); ++i) {
    const auto* f = plugin_get_input_frame(i);
    if (!f || !f->port_id || !f->payload) { error("invalid-input", "A chain input has no payload or port."); return finish(400, {}); }
    const plugin_input_frame_t** slot = nullptr;
    if (!std::strcmp(f->port_id, "omm")) slot = &seed;
    else if (!std::strcmp(f->port_id, "flight_config")) slot = &flight;
    else if (!std::strcmp(f->port_id, "fit_config")) slot = &policy;
    else if (!std::strcmp(f->port_id, "weather")) slot = &weather;
    if (!slot || *slot || f->payload_length > 8 * 1024 * 1024) {
      error("invalid-input", "Unknown, repeated, or oversized chain input."); return finish(400, {});
    }
    *slot = f;
  }
  if (!seed || !flight || !policy) { error("missing-input", "The chain requires OMM, flight PCF, and fit PCF."); return finish(400, {}); }
  input("omm", seed);
  int status = ingest_omm();
  auto fallback = take("ocm");
  if (status || fallback.empty()) { if (!status) error("missing-sgp4", "Ingestion emitted no SGP4 record."); return finish(status ? status : 500, {}); }
  inputs.clear(); input("ocm", fallback.data(), fallback.size()); input("configuration", flight);
  status = propagate();
  auto arc = take("ephemeris");
  if (status || arc.empty()) { if (!status) error("missing-flight", "Propagation emitted no flight."); return finish(status ? status : 500, fallback); }
  flatbuffers::Verifier verifier(arc.data(), arc.size());
  if (!catalog_wire::VerifyOEMBuffer(verifier)) { error("invalid-flight", "Propagation emitted an invalid OEM."); return finish(500, fallback); }
  std::unique_ptr<catalog_wire::OEMT> oem(catalog_wire::GetOEM(arc.data())->UnPack());
  if (oem->EPHEMERIS_DATA_BLOCK.size() != 1) { error("invalid-flight", "The catalog chain requires one flight block."); return finish(400, fallback); }
  auto& block = *oem->EPHEMERIS_DATA_BLOCK[0];
  block.USEABLE_START_TIME = block.START_TIME; block.USEABLE_STOP_TIME = block.STOP_TIME;
  flatbuffers::FlatBufferBuilder b;
  catalog_wire::FinishOEMBuffer(b, catalog_wire::OEM::Pack(b, oem.get()));
  inputs.clear(); input("ephemeris", b.GetBufferPointer(), b.GetSize()); input("configuration", policy);
  if (weather) input("space_weather", weather);
  status = fit();
  auto candidate = take("elements");
  if (!status && candidate.empty()) { status = 500; error("missing-fit", "Fitting emitted no candidate."); }
  return finish(status, fallback, candidate);
}

// A policy fallback needs only the propagator's original ingestion operation.
extern "C" int ingest_seed() {
  using namespace catalog_chain;
  inputs.clear(); reset();
  if (plugin_get_input_count() != 1) { error("invalid-input", "One seed frame is required."); return finish(400, {}); }
  const auto* seed = plugin_get_input_frame(0);
  if (!seed || !seed->port_id || std::strcmp(seed->port_id, "omm") || !seed->payload || seed->payload_length > 1024 * 1024) {
    error("invalid-input", "Expected one bounded OMM seed."); return finish(400, {});
  }
  input("omm", seed);
  const auto status = ingest_omm();
  auto fallback = take("ocm");
  if (!status && fallback.empty()) { error("missing-sgp4", "Ingestion emitted no SGP4 record."); return finish(500, {}); }
  return finish(status, fallback);
}
