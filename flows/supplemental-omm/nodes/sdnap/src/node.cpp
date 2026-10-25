// flows/supplemental-omm SDN-AP adapter node (typed contracts 1.0: FlatBuffers only).
//
//   prepare  in   oem             SDS $OEM, one object per frame (any source of the flow)
//            out  ephemeris       the same $OEM
//                 configuration   a $PCF 1.0 with THEORY SDNAP, every table at its default
//   wrap     in   elements        propagator/sdn-ap fit: $OMM (MEAN_ELEMENT_THEORY SDNAP, with COVARIANCE)
//                 determination   propagator/sdn-ap fit: $OBD (optional)
//            out  omm_meta, omm   IngestRequest (INGQ) + the size-prefixed $OMM record stream it files
//                 obd_meta, obd   the same for the $OBD
//
// The flow runtime hands a node one frame of each ready port per invocation and consumes it. propagator/sdn-ap fit
// has a required `configuration` port, so one $PCF has to arrive with every ephemeris: prepare emits the pair in one
// invocation, the two edges queue them in step, and the fit takes one of each. A host that batches hands prepare
// several ephemerides at once: they go out in order beside ONE $PCF, because the fit's configuration port takes one frame.

#include "space_data_module_invoke.h"

#include <cstdint>
#include <cstring>
#include <deque>
#include <string>
#include <vector>

#include <flatbuffers/flatbuffers.h>

#include "IngestRequest_generated.h"
#include "OBD_generated.h"
#include "OEM_generated.h"
#include "OMM_generated.h"
#include "PCF_generated.h"
#include "sds_cid.hpp"

namespace {

namespace R = sdn::runtime;

constexpr const char* kProviderId = "supplemental-omm";
constexpr const char* kSourceName = "sdn-ap";
constexpr const char* kParser = "org.sdn.flows.supplemental-omm.sdnap";
constexpr const char* kParserVersion = "1.0.0";

int32_t push(const char* port, const char* schema, const char* identifier, const char* root, const uint8_t* bytes,
             size_t size) {
  return plugin_push_output_ex(port, schema, identifier, PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, root, 0, 0, bytes,
                               static_cast<uint32_t>(size));
}

std::string hex(const uint8_t* bytes, size_t size) {
  static const char digits[] = "0123456789abcdef";
  std::string out(size * 2, '0');
  for (size_t i = 0; i < size; ++i) {
    out[2 * i] = digits[bytes[i] >> 4];
    out[2 * i + 1] = digits[bytes[i] & 15];
  }
  return out;
}

const plugin_input_frame_t* frame_for(const char* port) {
  const int32_t at = plugin_find_input_index(port, 0);
  return at < 0 ? nullptr : plugin_get_input_frame(static_cast<uint32_t>(at));
}

bool has_identifier(const plugin_input_frame_t* frame, const char* identifier, size_t at) {
  return frame && frame->payload && frame->payload_length >= at + 4 && std::memcmp(frame->payload + at, identifier, 4) == 0;
}

// One record framed for a stream: a bare FlatBuffer gets its length in front, a size-prefixed one is the frame.
bool framed(const plugin_input_frame_t* frame, const char* identifier, std::vector<uint8_t>* out) {
  if (has_identifier(frame, identifier, 4)) {
    const uint32_t size = frame->payload_length;
    out->assign({static_cast<uint8_t>(size), static_cast<uint8_t>(size >> 8), static_cast<uint8_t>(size >> 16),
                 static_cast<uint8_t>(size >> 24)});
    out->insert(out->end(), frame->payload, frame->payload + frame->payload_length);
    return true;
  }
  if (has_identifier(frame, identifier, 8)) {
    out->assign(frame->payload, frame->payload + frame->payload_length);
    return true;
  }
  return false;
}

bool push_batch(const char* code, const char* schema, const char* identifier, const char* root,
                const std::vector<uint8_t>& stream, uint64_t count) {
  uint8_t digest[32];
  sdn_cid::sha256_raw(stream.data(), stream.size(), digest);
  const std::string batch_id = hex(digest, sizeof digest);
  R::IngestRequestT request;
  request.SCHEMA = schema;
  request.TAGS = std::make_unique<R::SourceTagsT>();
  request.TAGS->PROVIDER_ID = kProviderId;
  request.TAGS->SOURCE_NAME = kSourceName;
  request.TAGS->BATCH_ID = batch_id;
  request.TAGS->CONTENT_KEY_ID = "public";
  request.RECONCILE = R::reconcileMode_Duplicates;
  request.PROVENANCE = std::make_unique<R::ProvenanceT>();
  request.PROVENANCE->PARSER = kParser;
  request.PROVENANCE->PARSER_VERSION = kParserVersion;
  request.PROVENANCE->NORMALIZED_SHA256 = batch_id;
  request.PROVENANCE->NORMALIZED_COUNT = count;
  flatbuffers::FlatBufferBuilder b(512);
  R::FinishIngestRequestBuffer(b, R::IngestRequest::Pack(b, &request));
  const std::string meta_port = std::string(code) + "_meta";
  return push(meta_port.c_str(), "IngestRequest.fbs", R::IngestRequestIdentifier(), "IngestRequest",
              b.GetBufferPointer(), b.GetSize()) >= 0 &&
         push(code, schema, identifier, root, stream.data(), stream.size()) >= 0;
}

}  // namespace

// Ephemerides taken in and not yet sent: one goes out an invocation, so the fit sees one ephemeris with its $PCF at a
// time and an ephemeris it refuses (too few states) costs only that object.
std::deque<std::vector<uint8_t>> g_pending;

int finish(int code) {
  plugin_set_backlog_remaining(static_cast<uint32_t>(g_pending.size()));
  plugin_set_yielded(g_pending.empty() ? 0 : 1);
  return code;
}

extern "C" int prepare(void) {
  plugin_reset_output_state();
  const uint32_t count = plugin_get_input_count();
  for (uint32_t index = 0; index < count; ++index) {
    const plugin_input_frame_t* oem = plugin_get_input_frame(index);
    if (!oem || !oem->payload || oem->payload_length < 8) {
      plugin_set_error("missing-oem-frame", "prepare requires an SDS $OEM.");
      return finish(400);
    }
    flatbuffers::Verifier verifier(oem->payload, oem->payload_length);
    if (!OEMBufferHasIdentifier(oem->payload) || !VerifyOEMBuffer(verifier)) {
      plugin_set_error("invalid-oem-frame", "the frame is not an SDS $OEM.");
      return finish(400);
    }
  }
  for (uint32_t index = 0; index < count; ++index) {
    const plugin_input_frame_t* oem = plugin_get_input_frame(index);
    g_pending.emplace_back(oem->payload, oem->payload + oem->payload_length);
  }
  if (g_pending.empty()) return finish(0);
  const std::vector<uint8_t> oem = std::move(g_pending.front());
  g_pending.pop_front();
  PCFT config;
  config.THEORY = pcfTheory::SDNAP;
  flatbuffers::FlatBufferBuilder b(128);
  FinishPCFBuffer(b, PCF::Pack(b, &config));
  if (push("ephemeris", "OEM.fbs", OEMIdentifier(), "OEM", oem.data(), oem.size()) < 0 ||
      push("configuration", "PCF.fbs", PCFIdentifier(), "PCF", b.GetBufferPointer(), b.GetSize()) < 0) {
    plugin_set_error("emit-failed", "unable to emit the ephemeris and its configuration.");
    return finish(500);
  }
  return finish(0);
}

extern "C" int wrap(void) {
  plugin_reset_output_state();
  // Every record of the invocation in one stream per standard, in the order the fit wrote them.
  std::vector<uint8_t> omm, obd;
  uint64_t omm_count = 0, obd_count = 0;
  for (int32_t k = 0;; ++k) {
    const int32_t at = plugin_find_input_index("elements", static_cast<uint32_t>(k));
    if (at < 0) break;
    std::vector<uint8_t> record;
    if (!framed(plugin_get_input_frame(static_cast<uint32_t>(at)), OMMIdentifier(), &record)) {
      plugin_set_error("invalid-elements-frame", "wrap requires the fit's $OMM.");
      return 400;
    }
    omm.insert(omm.end(), record.begin(), record.end());
    ++omm_count;
  }
  for (int32_t k = 0;; ++k) {
    const int32_t at = plugin_find_input_index("determination", static_cast<uint32_t>(k));
    if (at < 0) break;
    std::vector<uint8_t> record;
    if (!framed(plugin_get_input_frame(static_cast<uint32_t>(at)), OBDIdentifier(), &record)) {
      plugin_set_error("invalid-determination-frame", "the determination frame is not an $OBD.");
      return 400;
    }
    obd.insert(obd.end(), record.begin(), record.end());
    ++obd_count;
  }
  if (omm_count == 0) {
    plugin_set_error("missing-elements-frame", "wrap requires the fit's $OMM.");
    return 400;
  }
  if (!push_batch("omm", "OMM.fbs", OMMIdentifier(), "OMM", omm, omm_count) ||
      (obd_count > 0 && !push_batch("obd", "OBD.fbs", OBDIdentifier(), "OBD", obd, obd_count))) {
    plugin_set_error("emit-failed", "unable to emit the batches.");
    return 500;
  }
  return 0;
}
