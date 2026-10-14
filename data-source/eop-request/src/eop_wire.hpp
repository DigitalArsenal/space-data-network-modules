// Typed frames shared by eop-request and eop-parser (typed contracts 1.0: FlatBuffers only, no JSON and no base64).
// The job travels as HttpRequest.CONTEXT: one size-prefixed SDS $ICN (Ingest Connector) record naming the source, which
// hostcap/http-request echoes verbatim in the HttpResponse. No network or physics here.
#include <cstdint>
#include <cstring>
#include <string>
#include <vector>

#include "space_data_module_invoke.h"
#include "TimerTick_generated.h"
#include "HttpRequest_generated.h"
#include "HttpResponse_generated.h"
#include "IngestRequest_generated.h"
#include "FlowNotice_generated.h"
#include "ICN_generated.h"
namespace eop_wire {
namespace R = sdn::runtime;
struct Source {
  const char* name;
  const char* url;
  const char* format;
};
static const Source sources[] = {
    {"IERS finals2000A Bulletin A columns",
     "https://datacenter.iers.org/data/9/finals2000A.all", "finals2000a"},
    {"IERS EOP 20 C04",
     "https://hpiers.obspm.fr/iers/eop/eopc04/eopc04.1962-now", "c04"},
    {"Paris Observatory EOP 20 C04 legacy IAU2000 format",
     "https://hpiers.obspm.fr/iers/eop/eopc04/eopc04_IAU2000.62-now", "paris"}};
inline const plugin_input_frame_t* frame(const char* port) {
  int i = plugin_find_input_index(port, 0);
  return i < 0 ? nullptr : plugin_get_input_frame(i);
}
inline int error(const char* message) {
  plugin_set_error("invalid-eop-input", message);
  return 3;
}
inline bool unique_inputs() {
  for (uint32_t i = 0; i < plugin_get_input_count(); ++i) {
    auto a = plugin_get_input_frame(i);
    for (uint32_t j = 0; j < i; ++j)
      if (std::strcmp(a->port_id, plugin_get_input_frame(j)->port_id) == 0)
        return false;
  }
  return true;
}
// The job: one size-prefixed $ICN record (CONNECTOR_ID and DATASET_ID the format, SOURCE_NAME the series name,
// ENDPOINT_URL the file, TARGET_SCHEMA EOP.fbs, EMITS_SCHEMAS ["EOP"]).
inline std::vector<uint8_t> job(const Source& s) {
  flatbuffers::FlatBufferBuilder b(512);
  auto id = b.CreateString(s.format), schema = b.CreateString("EOP.fbs"),
       url = b.CreateString(s.url), method = b.CreateString("GET"),
       dataset = b.CreateString(s.format), name = b.CreateString(s.name);
  auto emits = b.CreateVector(std::vector<flatbuffers::Offset<flatbuffers::String>>{b.CreateString("EOP")});
  ICNBuilder icn(b);
  icn.add_CONNECTOR_ID(id);
  icn.add_KIND(icnConnectorKind_HttpsPull);
  icn.add_TARGET_SCHEMA(schema);
  icn.add_ENDPOINT_URL(url);
  icn.add_HTTP_METHOD(method);
  icn.add_POST_INGEST_ACTION(icnPostIngestAction_LeaveInPlace);
  icn.add_DATASET_ID(dataset);
  icn.add_SOURCE_NAME(name);
  icn.add_EMITS_SCHEMAS(emits);
  FinishSizePrefixedICNBuffer(b, icn.Finish());
  return std::vector<uint8_t>(b.GetBufferPointer(), b.GetBufferPointer() + b.GetSize());
}
inline int push_flatbuffer(const char* port, const char* schema, const char* id, const char* root,
                           const uint8_t* data, size_t size) {
  return plugin_push_output_ex(port, schema, id, PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, root, 0, 0, data,
                               static_cast<uint32_t>(size));
}
}  // namespace eop_wire
