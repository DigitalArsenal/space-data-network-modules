// flows/supplemental-omm SDN-AP adapter node (typed contracts 1.0: FlatBuffers only).
//
//   prepare  in   oem             SDS $OEM, one object per frame (any source of the flow)
//            out  ephemeris       the same $OEM
//                 configuration   a $PCF 1.0 with THEORY SDNAP, every table at its default
//   catalog_request  in   tick            TimerTick: the flow's timer
//            out  request         a $QRP Request for the node's current $OMM catalog (SOURCE_NAME celestrak-gp,
//                                 TIME_PROFILE nearest), asking the host for the records inline
//   from_page  in  page            data-source/retrieval omm_bulk's $QRP page: its header, then the records
//            out  omm             one catalog $OMM an invocation, yielding until the page is sent
//                 configuration   a $PCF with every table at its default (propagator/sdn-ap propagate: each set's own theory)
//   publish_request  in  result, meta   as the OD node's: the IngestResult and IngestRequest it stored
//            out  request         the dataset-publication POST (config omm_publish_url)
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
#include "typedHostcall.hpp"

#include <cstdint>
#include <cstring>
#include <deque>
#include <string>
#include <vector>

#include <flatbuffers/flatbuffers.h>

#include "HttpRequest_generated.h"
#include "IngestRequest_generated.h"
#include "IngestResult_generated.h"
#include "OBD_generated.h"
#include "OEM_generated.h"
#include "OMM_generated.h"
#include "PCF_generated.h"
#include "QRP_generated.h"
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
  for (int32_t k = 0;; ++k) {
    const int32_t at = plugin_find_input_index("oem", static_cast<uint32_t>(k));
    if (at < 0) break;
    const plugin_input_frame_t* oem = plugin_get_input_frame(static_cast<uint32_t>(at));
    if (!oem || !oem->payload || oem->payload_length < 8) {
      plugin_set_error("missing-oem-frame", "prepare requires an SDS $OEM.");
      return finish(400);
    }
    flatbuffers::Verifier verifier(oem->payload, oem->payload_length);
    if (!OEMBufferHasIdentifier(oem->payload) || !VerifyOEMBuffer(verifier)) {
      plugin_set_error("invalid-oem-frame", "the frame is not an SDS $OEM.");
      return finish(400);
    }
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

namespace {

std::string text_of(const flatbuffers::String* s) { return s ? s->str() : std::string(); }

constexpr const char* kCatalogSource = "celestrak-gp";

// The catalog records taken from a page and not yet sent, in the page's order.
std::deque<std::vector<uint8_t>> g_catalog;

}  // namespace

extern "C" int catalog_request(void) {
  plugin_reset_output_state();
  QRPT request;
  request.KIND = qrpKind::Request;
  request.SCHEMA_NAME = "OMM.fbs";
  request.SOURCE_NAME = kCatalogSource;
  request.TIME_PROFILE = qrpTimeProfile::Nearest;
  // Json asks the host for the records inline (the page carries them); the answer is still the FlatBuffer stream.
  request.REPRESENTATION = qrpRepresentation::Json;
  flatbuffers::FlatBufferBuilder b(256);
  FinishQRPBuffer(b, QRP::Pack(b, &request));
  if (push("request", "QRP.fbs", QRPIdentifier(), "QRP", b.GetBufferPointer(), b.GetSize()) < 0) {
    plugin_set_error("emit-failed", "unable to emit the catalog request.");
    return 500;
  }
  return 0;
}

namespace {

int finish_catalog(int code) {
  plugin_set_backlog_remaining(static_cast<uint32_t>(g_catalog.size()));
  plugin_set_yielded(g_catalog.empty() ? 0 : 1);
  return code;
}

// The records of a page: the size-prefixed $QRP header, zero-length prefixes of padding, then size-prefixed records.
bool take_page(const plugin_input_frame_t* frame, std::deque<std::vector<uint8_t>>* out, std::string* why) {
  const uint8_t* p = frame->payload;
  const size_t n = frame->payload_length;
  auto u32 = [&](size_t at) { return static_cast<size_t>(p[at]) | static_cast<size_t>(p[at + 1]) << 8 | static_cast<size_t>(p[at + 2]) << 16 | static_cast<size_t>(p[at + 3]) << 24; };
  if (n < 12 || u32(0) + 4 > n || std::memcmp(p + 8, "$QRP", 4) != 0) {
    *why = "the page is not a size-prefixed $QRP";
    return false;
  }
  flatbuffers::Verifier verifier(p, 4 + u32(0));
  if (!VerifySizePrefixedQRPBuffer(verifier)) {
    *why = "the page header is not a $QRP";
    return false;
  }
  const QRP* header = GetSizePrefixedQRP(p);
  if (header->KIND() == qrpKind::Error) {
    *why = "the host refused the catalog request: " + text_of(header->ERROR_CODE()) + " " + text_of(header->MESSAGE());
    return false;
  }
  if (header->BODY_REF_TOKEN() != 0) {
    *why = "the host kept the records by reference; the request asks for them inline";
    return false;
  }
  size_t at = 4 + u32(0);
  while (at + 4 <= n) {
    const size_t size = u32(at);
    if (size == 0) {
      at += 4;
      continue;
    }
    if (size < 8 || at + 4 + size > n) {
      *why = "a record of the page overruns it";
      return false;
    }
    out->emplace_back(p + at, p + at + 4 + size);  // the frame, size prefix and all
    at += 4 + size;
  }
  return true;
}

}  // namespace

extern "C" int from_page(void) {
  plugin_reset_output_state();
  for (int32_t k = 0;; ++k) {
    const int32_t at = plugin_find_input_index("page", static_cast<uint32_t>(k));
    if (at < 0) break;
    std::string why;
    if (!take_page(plugin_get_input_frame(static_cast<uint32_t>(at)), &g_catalog, &why)) {
      plugin_set_error("invalid-catalog-page", why.c_str());
      return finish_catalog(400);
    }
  }
  if (g_catalog.empty()) return finish_catalog(0);
  std::vector<uint8_t> record = std::move(g_catalog.front());
  g_catalog.pop_front();
  // A record of the page is size-prefixed; the fit's neighbours read the plain buffer.
  PCFT config;
  flatbuffers::FlatBufferBuilder b(128);
  FinishPCFBuffer(b, PCF::Pack(b, &config));
  if (push("omm", "OMM.fbs", OMMIdentifier(), "OMM", record.data() + 4, record.size() - 4) < 0 ||
      push("configuration", "PCF.fbs", PCFIdentifier(), "PCF", b.GetBufferPointer(), b.GetSize()) < 0) {
    plugin_set_error("emit-failed", "unable to emit the catalog record and its configuration.");
    return finish_catalog(500);
  }
  return finish_catalog(0);
}

// publish_request: hostcap/storage-ingest's IngestResults (+ the IngestRequests they stored, when they come) -> one
// dataset-publication POST for each (omm_publish_url), its BODY the IngestResult naming the stored batch; nothing when
// omm_publish_url is unset or the batch was refused. This adapter files every batch under one provider and source, so
// an IngestResult that does not name them is published under those.
extern "C" int publish_request(void) {
  plugin_reset_output_state();
  const sdm_piv::Config config = sdm_piv::get_config();
  const std::string url(config.string("omm_publish_url", ""));
  uint32_t results = 0;
  for (int32_t k = 0;; ++k) {
    const int32_t at = plugin_find_input_index("result", static_cast<uint32_t>(k));
    if (at < 0) break;
    ++results;
    const plugin_input_frame_t* result_frame = plugin_get_input_frame(static_cast<uint32_t>(at));
    if (!result_frame || !result_frame->payload || result_frame->payload_length == 0) {
      plugin_set_error("missing-result-frame", "publish_request requires the storage-ingest result frame.");
      return 400;
    }
    flatbuffers::Verifier result_verifier(result_frame->payload, result_frame->payload_length);
    if (!R::VerifyIngestResultBuffer(result_verifier)) {
      plugin_set_error("invalid-result-frame", "the result frame is not an IngestResult (INGR).");
      return 400;
    }
    if (url.empty()) continue;
    const R::IngestResult& result = *R::GetIngestResult(result_frame->payload);
    if (result.REFUSED() && result.REFUSED()->size()) continue;  // nothing stored, nothing to publish
    const int32_t meta_at = plugin_find_input_index("meta", static_cast<uint32_t>(k));
    const plugin_input_frame_t* meta_frame = meta_at < 0 ? nullptr : plugin_get_input_frame(static_cast<uint32_t>(meta_at));
    const R::IngestRequest* meta = nullptr;
    if (meta_frame && meta_frame->payload && meta_frame->payload_length > 0) {
      flatbuffers::Verifier meta_verifier(meta_frame->payload, meta_frame->payload_length);
      if (R::VerifyIngestRequestBuffer(meta_verifier)) meta = R::GetIngestRequest(meta_frame->payload);
    }
    std::string schema = text_of(result.SCHEMA()), batch_id = text_of(result.BATCH_ID());
    std::string provider = text_of(result.PROVIDER_ID()), source = text_of(result.SOURCE_NAME());
    if (meta) {
      if (schema.empty()) schema = text_of(meta->SCHEMA());
      if (meta->TAGS()) {
        if (batch_id.empty()) batch_id = text_of(meta->TAGS()->BATCH_ID());
        if (provider.empty()) provider = text_of(meta->TAGS()->PROVIDER_ID());
        if (source.empty()) source = text_of(meta->TAGS()->SOURCE_NAME());
      }
    }
    if (provider.empty()) provider = kProviderId;
    if (source.empty()) source = kSourceName;
    if (schema.empty() || batch_id.empty()) {
      plugin_set_error("incomplete-publication-identity", "publish_request needs the stored batch's schema and batchId.");
      return 400;
    }
    flatbuffers::FlatBufferBuilder body_builder(512);
    R::FinishIngestResultBuffer(
        body_builder,
        R::CreateIngestResultDirect(body_builder, schema.c_str(), provider.c_str(), source.c_str(), batch_id.c_str(),
                                    result.INSERTED(), result.RECONCILED_DUPLICATES(), result.RECONCILED_OLD_BATCHES(),
                                    result.ARCHIVED() && result.ARCHIVED()->size() ? result.ARCHIVED()->c_str() : nullptr,
                                    nullptr));
    const std::vector<uint8_t> body(body_builder.GetBufferPointer(), body_builder.GetBufferPointer() + body_builder.GetSize());
    flatbuffers::FlatBufferBuilder b(512 + body.size());
    std::vector<flatbuffers::Offset<R::Header>> headers{R::CreateHeaderDirect(b, "content-type", "application/octet-stream")};
    R::FinishHttpRequestBuffer(b, R::CreateHttpRequestDirect(b, "POST", url.c_str(), &headers, &body,
                                                             static_cast<uint32_t>(config.number("omm_publish_timeout_ms", 30000)),
                                                             0, nullptr));
    if (push("request", "HttpRequest.fbs", R::HttpRequestIdentifier(), "HttpRequest", b.GetBufferPointer(), b.GetSize()) < 0) {
      plugin_set_error("emit-failed", "unable to emit the publication HttpRequest.");
      return 500;
    }
  }
  if (results == 0) {
    plugin_set_error("missing-result-frame", "publish_request requires the storage-ingest result frame.");
    return 400;
  }
  return 0;
}
