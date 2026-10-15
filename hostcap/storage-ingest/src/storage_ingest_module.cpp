/*
 * hostcap/storage-ingest — the host storage.ingest_with_source connector (typed contracts 1.0).
 *
 *   ingest — inputs:
 *     "meta"    ONE IngestRequest (INGQ, module-sdk runtime type) authored by the parser node: SCHEMA, TAGS
 *               (SourceTags attribution: provider/source/batch/url/content key/source peer/licence), RECONCILE,
 *               optional ARCHIVE naming and optional PROVENANCE.
 *     "<code>_records"  ONE size-prefixed SDS record stream (the batch), passed through verbatim, on the port of its
 *               standard (omm_records, wxf_records, ...: a typed port names one type, so a generic ingest node has one
 *               optional port per standard it accepts). Exactly one of them carries a frame, and its standard must be
 *               the IngestRequest's SCHEMA.
 *     "raw"     OPTIONAL: the HttpResponse (HRSP) the batch was made from; its BODY is the raw document the host
 *               archives when the request names an ARCHIVE target.
 *   output:
 *     "result"  ONE IngestResult (INGR): what the host did with the batch, or REFUSED saying why it was not stored.
 *
 * The hostcall is an SDS $PIV invocation of storage.ingest_with_source: the StorageIngestParams aligned record
 * (flat source tags, RECONCILE, ARCHIVE_SOURCE / ARCHIVE_NAME), raw "records", raw "archive" (only when both the
 * archive naming and the raw bytes are present, as before: naming without bytes is dropped, bytes without naming are
 * ignored) and list "provenance" (one Provenance aligned record when the request carries PROVENANCE).
 *
 * NOTHING IS TRUNCATED. The aligned record's strings are bounded (SOURCE_URL 255, BATCH_ID 128, ...). A value that does
 * not fit is not cut to fit: the batch is answered with an IngestResult whose REFUSED names the field and its bound,
 * and no hostcall is made. A host that refuses the batch (policy, the disk guardrail, the capability grant: error codes
 * "refused" / "not-authorized" / "too-large") is answered the same way. Any other host failure fails the node, as the
 * JSON lane did.
 *
 * No JSON and no base64 anywhere. Every DECISION (attribution, reconcile mode, archive naming) was made upstream in the
 * parser; the host side is policy-mediated by the storage_ingest capability grant.
 */

#include <cstdint>
#include <cstdio>
#include <cstring>
#include <string>
#include <string_view>
#include <vector>

#include "space_data_module_invoke.h"
#include "typedHostcall.hpp"
#include "HttpResponse_generated.h"
#include "IngestRequest_generated.h"
#include "IngestResult_generated.h"

namespace {

namespace A = sdn::runtime::Aligned;
namespace R = sdn::runtime;

const plugin_input_frame_t* frame_for(const char* port) {
    const int32_t idx = plugin_find_input_index(port, 0);
    if (idx < 0) return nullptr;
    return plugin_get_input_frame(static_cast<uint32_t>(idx));
}

// ---------------------------------------------------------------------------
// SURPLUS-FRAME REFUSAL — graph task `modules-guest-nodes-drop-batched-frames`.
//
// `space_data_module_runtime_begin_node_invocation` (module-SDK src/flow/runtime-src/flow_runtime.cpp) fills an
// invocation by popping the node's queue PORT-BLIND up to a drain budget of 64; `maxStreams`, `maxBatch` and
// `drainPolicy` are purely DECLARATIVE in the compiled runtime. A guest that reads ordinal 0 of a port and returns
// DESTROYS every other frame it was handed on that port (live P1 `cellular-multiprovider-returns-only-first-provider`).
//
// `ingest` describes ONE batch: the IngestRequest's batch id, counts and archive naming were computed over exactly one
// records stream and one raw document, so a second records frame cannot be merged into it. A surplus is REFUSED by
// name rather than silently dropped.
bool find_batched_input_port(char* message, size_t message_len) {
    const uint32_t count = plugin_get_input_count();
    for (uint32_t i = 0; i < count; i++) {
        const plugin_input_frame_t* frame = plugin_get_input_frame(i);
        if (!frame || !frame->port_id) continue;
        for (uint32_t j = 0; j < i; j++) {
            const plugin_input_frame_t* earlier = plugin_get_input_frame(j);
            if (!earlier || !earlier->port_id) continue;
            if (std::strcmp(earlier->port_id, frame->port_id) != 0) continue;
            uint32_t on_port = 0;
            for (uint32_t k = 0; k < count; k++) {
                const plugin_input_frame_t* f = plugin_get_input_frame(k);
                if (f && f->port_id && std::strcmp(f->port_id, frame->port_id) == 0) on_port++;
            }
            std::snprintf(message, message_len,
                          "This invocation carries %u frames on single-stream input port \"%s\" "
                          "(the compiled flow runtime drains a node's whole queue port-blind; "
                          "maxStreams is declarative only). The surplus frames are refused "
                          "rather than silently discarded.",
                          on_port, frame->port_id);
            return true;
        }
    }
    return false;
}

// The standard code of a schema name: "WXF.fbs", "$WXF", "wxf" -> "WXF".
std::string code_of(std::string_view schema) {
    if (!schema.empty() && schema.front() == '$') schema.remove_prefix(1);
    if (schema.size() > 4 && schema.substr(schema.size() - 4) == ".fbs") schema.remove_suffix(4);
    std::string out(schema);
    for (char& c : out) if (c >= 'a' && c <= 'z') c = static_cast<char>(c - 'a' + 'A');
    return out;
}

bool is_records_port(const char* port) {
    const size_t n = std::strlen(port);
    return n > 8 && std::strcmp(port + n - 8, "_records") == 0;
}

// One string of the request into its bounded aligned field. Empty / absent leaves the field unset. A value longer
// than the field's bound is NOT truncated: `why` names it (the first one found) and the batch is refused.
template <size_t N>
bool fit(flatbuffers::aligned_runtime::AlignedString<N>& field, const flatbuffers::String* value, const char* name,
         std::string& why) {
    if (!value || value->size() == 0) return false;
    if (sdm_piv::put(field, value->string_view())) return true;
    if (why.empty()) {
        why = std::string(name) + " is " + std::to_string(value->size()) +
              " bytes; the storage.ingest_with_source record holds at most " + std::to_string(N) +
              " - the batch is refused rather than stored under a truncated value";
    }
    return false;
}
#define SDM_FIT(record, FIELD, value, name) \
    if (fit(record.FIELD, value, name, why)) record.set_has_##FIELD(true)

const char* text_of(const flatbuffers::String* s) { return s ? s->c_str() : ""; }

int push_result(flatbuffers::FlatBufferBuilder& b) {
    return plugin_push_output_ex("result", "IngestResult.fbs", R::IngestResultIdentifier(),
                                 PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, "IngestResult", 0, 0, b.GetBufferPointer(),
                                 static_cast<uint32_t>(b.GetSize()));
}

// The batch was not stored: an IngestResult naming the lane and REFUSED saying why.
int refuse(const R::IngestRequest& request, const std::string& why) {
    flatbuffers::FlatBufferBuilder b(512);
    const auto* tags = request.TAGS();
    R::FinishIngestResultBuffer(
        b, R::CreateIngestResultDirect(b, text_of(request.SCHEMA()), text_of(tags->PROVIDER_ID()),
                                       text_of(tags->SOURCE_NAME()), text_of(tags->BATCH_ID()), 0, 0, 0, nullptr,
                                       why.c_str()));
    return push_result(b) < 0 ? 500 : 0;
}

bool is_refusal(const std::string& code) {
    return code == "refused" || code == "not-authorized" || code == "too-large";
}

}  // namespace

extern "C" {

int ingest(void) {
    char batch_message[384];
    if (find_batched_input_port(batch_message, sizeof(batch_message))) {
        plugin_set_error("batched-input-frames", batch_message);
        return 500;
    }

    const plugin_input_frame_t* meta_frame = frame_for("meta");
    if (!meta_frame || !meta_frame->payload || meta_frame->payload_length == 0) {
        plugin_set_error("missing-meta-frame", "ingest requires the IngestRequest frame on \"meta\".");
        return 400;
    }
    // The batch's record stream: exactly one frame across the *_records ports.
    const plugin_input_frame_t* records_frame = nullptr;
    for (uint32_t i = 0; i < plugin_get_input_count(); i++) {
        const plugin_input_frame_t* frame = plugin_get_input_frame(i);
        if (!frame || !frame->port_id || !is_records_port(frame->port_id)) continue;
        if (records_frame) {
            char message[256];
            std::snprintf(message, sizeof message,
                          "one batch is ONE record stream, but this invocation carries \"%s\" and \"%s\"; each "
                          "stream needs its own IngestRequest.",
                          records_frame->port_id, frame->port_id);
            plugin_set_error("batched-input-frames", message);
            return 500;
        }
        records_frame = frame;
    }
    if (!records_frame || !records_frame->payload || records_frame->payload_length == 0) {
        plugin_set_error("missing-records-frame", "ingest requires the record stream frame on a *_records port.");
        return 400;
    }
    const plugin_input_frame_t* raw_frame = frame_for("raw");  // optional

    flatbuffers::Verifier verifier(meta_frame->payload, meta_frame->payload_length);
    if (!R::VerifyIngestRequestBuffer(verifier)) {
        plugin_set_error("invalid-meta", "the meta frame is not an IngestRequest (INGQ) with SCHEMA and TAGS.");
        return 400;
    }
    const R::IngestRequest& request = *R::GetIngestRequest(meta_frame->payload);
    const R::SourceTags& tags = *request.TAGS();

    // The stream's standard is the port it arrived on; the request names the standard it is filed under. A
    // contradiction is refused, not resolved: records filed under the wrong standard are records nothing finds.
    const std::string port(records_frame->port_id);
    const std::string stream_code = code_of(std::string_view(port).substr(0, port.size() - 8));
    const std::string schema_code = code_of(request.SCHEMA()->string_view());
    if (stream_code != schema_code) {
        const std::string message = "the IngestRequest's SCHEMA is \"" + request.SCHEMA()->str() +
                                    "\" but the record stream arrived on \"" + port + "\" ($" + stream_code +
                                    "); the batch is refused rather than filed under either.";
        plugin_set_error("record-type-disagreement", message.c_str());
        return 400;
    }

    const R::HttpResponse* raw = nullptr;
    if (raw_frame && raw_frame->payload && raw_frame->payload_length > 0) {
        flatbuffers::Verifier raw_verifier(raw_frame->payload, raw_frame->payload_length);
        if (!R::VerifyHttpResponseBuffer(raw_verifier)) {
            plugin_set_error("invalid-raw", "the raw frame is not an HttpResponse (HRSP).");
            return 400;
        }
        raw = R::GetHttpResponse(raw_frame->payload);
    }
    const bool has_raw = raw && raw->BODY() && raw->BODY()->size() > 0;
    const R::ArchiveTarget* archive = request.ARCHIVE();
    const bool archiving = archive && has_raw;

    std::string why;
    A::StorageIngestParams params{};
    SDM_FIT(params, SCHEMA, request.SCHEMA(), "SCHEMA");
    SDM_FIT(params, PROVIDER_ID, tags.PROVIDER_ID(), "TAGS.PROVIDER_ID");
    SDM_FIT(params, SOURCE_NAME, tags.SOURCE_NAME(), "TAGS.SOURCE_NAME");
    SDM_FIT(params, BATCH_ID, tags.BATCH_ID(), "TAGS.BATCH_ID");
    SDM_FIT(params, SOURCE_URL, tags.SOURCE_URL(), "TAGS.SOURCE_URL");
    SDM_FIT(params, CONTENT_KEY_ID, tags.CONTENT_KEY_ID(), "TAGS.CONTENT_KEY_ID");
    SDM_FIT(params, SOURCE_PEER, tags.SOURCE_PEER(), "TAGS.SOURCE_PEER");
    SDM_FIT(params, LICENSE, tags.LICENSE(), "TAGS.LICENSE");
    SDM_FIT(params, LICENSE_URL, tags.LICENSE_URL(), "TAGS.LICENSE_URL");
    SDM_FIT(params, CITATION, tags.CITATION(), "TAGS.CITATION");
    params.SHARE_ALIKE = tags.SHARE_ALIKE();
    // reconcileMode and reconcileKind are the same enum (Duplicates, None, Current).
    params.RECONCILE = static_cast<A::reconcileKind>(request.RECONCILE());
    if (archiving) {
        SDM_FIT(params, ARCHIVE_SOURCE, archive->SOURCE(), "ARCHIVE.SOURCE");
        SDM_FIT(params, ARCHIVE_NAME, archive->NAME(), "ARCHIVE.NAME");
    }

    // Provenance: one aligned record. SCHEMAS / SCHEMA_COUNTS / WARNINGS have no field in the hostcall's Provenance
    // record (HostOps.fbs), so they do not travel; every field that has one does, unshortened.
    A::Provenance provenance{};
    const R::Provenance* p = request.PROVENANCE();
    if (p) {
        SDM_FIT(provenance, SOURCE_URL, p->SOURCE_URL(), "PROVENANCE.SOURCE_URL");
        SDM_FIT(provenance, ETAG, p->ETAG(), "PROVENANCE.ETAG");
        SDM_FIT(provenance, LAST_MODIFIED, p->LAST_MODIFIED(), "PROVENANCE.LAST_MODIFIED");
        SDM_FIT(provenance, CONTENT_TYPE, p->CONTENT_TYPE(), "PROVENANCE.CONTENT_TYPE");
        SDM_FIT(provenance, PARSER, p->PARSER(), "PROVENANCE.PARSER");
        SDM_FIT(provenance, PARSER_VERSION, p->PARSER_VERSION(), "PROVENANCE.PARSER_VERSION");
        SDM_FIT(provenance, SOURCE_SHA256, p->SOURCE_SHA256(), "PROVENANCE.SOURCE_SHA256");
        SDM_FIT(provenance, NORMALIZED_SHA256, p->NORMALIZED_SHA256(), "PROVENANCE.NORMALIZED_SHA256");
        provenance.HTTP_STATUS = p->HTTP_STATUS();
        provenance.RETRIEVED_MS = p->RETRIEVED_MS();
        provenance.NORMALIZED_COUNT = p->NORMALIZED_COUNT();
        provenance.FROM_CACHE = p->FROM_CACHE();
    }
    // PROVENANCE.ATTRIBUTES (descriptive provenance: method, units, ranges, ...) -> list "provenance_attributes", in
    // order, each a ProvenanceAttribute {NAME 128, VALUE 255}; one that does not fit is refused by index, never cut.
    std::vector<A::ProvenanceAttribute> attributes;
    if (p && p->ATTRIBUTES()) {
        for (flatbuffers::uoffset_t i = 0; i < p->ATTRIBUTES()->size() && why.empty(); i++) {
            const auto* h = p->ATTRIBUTES()->Get(i);
            A::ProvenanceAttribute attribute{};
            const std::string at = "PROVENANCE.ATTRIBUTES[" + std::to_string(i) + "]";
            SDM_FIT(attribute, NAME, h->NAME(), (at + ".NAME").c_str());
            SDM_FIT(attribute, VALUE, h->VALUE(), (at + ".VALUE").c_str());
            attributes.push_back(attribute);
        }
    }
    if (!why.empty()) return refuse(request, why);

    std::vector<sdm_piv::Frame> frames{
        {"params", reinterpret_cast<const uint8_t*>(&params), sizeof params, "StorageIngestParams",
         static_cast<uint32_t>(sizeof params), static_cast<uint16_t>(alignof(A::StorageIngestParams))},
        sdm_piv::raw("records", records_frame->payload, records_frame->payload_length),
    };
    if (archiving) frames.push_back(sdm_piv::raw("archive", raw->BODY()->data(), raw->BODY()->size()));
    if (p) frames.push_back(sdm_piv::list("provenance", "Provenance", &provenance, 1));
    if (!attributes.empty()) {
        frames.push_back(sdm_piv::list("provenance_attributes", "ProvenanceAttribute", attributes.data(), attributes.size()));
    }

    const auto response = sdm_piv::call_frames("storage.ingest_with_source", frames);
    if (!response.ok()) {
        const std::string code = response.error_code();
        std::string message = response.error_message();
        if (message.empty()) message = "storage.ingest_with_source hostcall failed.";
        if (is_refusal(code)) return refuse(request, code + ": " + message);
        plugin_set_error("ingest-failed", message.c_str());
        return 502;
    }
    const auto* stored = response.result<A::StorageIngestResult>("StorageIngestResult");

    flatbuffers::FlatBufferBuilder b(512);
    const std::string schema = stored && stored->SCHEMA.length ? stored->SCHEMA.str() : std::string(text_of(request.SCHEMA()));
    const std::string batch_id = stored && stored->BATCH_ID.length ? stored->BATCH_ID.str() : std::string(text_of(tags.BATCH_ID()));
    const std::string archived = stored ? stored->ARCHIVED.str() : std::string();
    R::FinishIngestResultBuffer(
        b, R::CreateIngestResultDirect(b, schema.c_str(), text_of(tags.PROVIDER_ID()), text_of(tags.SOURCE_NAME()),
                                       batch_id.c_str(), stored ? stored->INSERTED : 0,
                                       stored ? stored->RECONCILED_DUPLICATES : 0,
                                       stored ? stored->RECONCILED_OLD_BATCHES : 0,
                                       archived.empty() ? nullptr : archived.c_str(), nullptr));
    return push_result(b) < 0 ? 500 : 0;
}

}  // extern "C"
