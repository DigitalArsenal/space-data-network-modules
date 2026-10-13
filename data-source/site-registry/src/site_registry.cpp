#include "space_data_module_invoke.h"
// The site registry: every site the console shows (nuclear, chemical and
// biological laboratories and facilities, storage sites, research bodies,
// nuclear power plants, space sites and the GeoNames nuclear placemarks) as
// SDS $SIT 1.1.0 records with a cited lifecycle, description, references,
// parties and quantities, and their $GNP search projection (owner
// 2026-10-13: "It should all load over SDN, that's the whole point").
//
// Stages (src/driver.hpp; the flow chains them): plan, entities_a..c,
// parties, articles_a..c, finish. Fetching, storage and publication belong to
// the host: the node's auto-publisher announces SIT.fbs and GNP.fbs, provider
// sdn-site-registry, sources sites and site-places.

namespace {
int run(const char* stage) {
  sr::StageIO io;
  for (uint32_t i = 0; i < plugin_get_input_count(); ++i) {
    const auto* f = plugin_get_input_frame(i);
    if (!f || !f->port_id) continue;
    io.inputs.push_back({f->port_id, f->payload, f->payload_length});
  }
  if (!sr::runStage(stage, io)) {
    plugin_set_error("site-registry", io.error.c_str());
    return 1;
  }
  for (const auto& o : io.outputs) {
    const int rc = o.flatbuffer
        ? plugin_push_output_ex(o.port.c_str(), o.schema.c_str(), o.fileId.c_str(), PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, o.root.c_str(), 0, 0, o.bytes.data(), o.bytes.size())
        : plugin_push_output_ex(o.port.c_str(), nullptr, nullptr, PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY, nullptr, 0, 1, o.bytes.data(), o.bytes.size());
    if (rc < 0) return 1;
  }
  return 0;
}
}  // namespace

extern "C" int plan() { return run("plan"); }
extern "C" int entities_a() { return run("entities_a"); }
extern "C" int entities_b() { return run("entities_b"); }
extern "C" int entities_c() { return run("entities_c"); }
extern "C" int parties() { return run("parties"); }
extern "C" int articles_a() { return run("articles_a"); }
extern "C" int articles_b() { return run("articles_b"); }
extern "C" int articles_c() { return run("articles_c"); }
extern "C" int finish() { return run("finish"); }
