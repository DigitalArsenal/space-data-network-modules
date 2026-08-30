/*
 * files/ccsds-messages — the CCSDS message reader/writer surface.
 *
 * TWO RECORDS, BECAUSE A MESSAGE FILE IS TWO THINGS
 *
 * `$AEM` holds the attitude states and `$TDM` the observations. `$NCD` holds
 * what is true of the FILE and of no state in it: which of the two CCSDS
 * keyword-value formats it is, the version it declared, its originator and
 * creation date, its header comment area, the time system its metadata named,
 * and the SHA-256 of the exact bytes that were read. A reader that emits only
 * the record makes that half unrecoverable, and a writer downstream then
 * invents a header instead of reproducing one. Every method here emits the
 * descriptor.
 *
 * HOW THE BYTES ARRIVE, AND WHY THIS SHAPE
 *
 * `$NCD` describes a file; it does not carry one. It has SOURCE_SHA256,
 * SOURCE_BYTE_LENGTH and SOURCE_CID and no payload field, which is correct — a
 * descriptor that embedded its subject would have to be rebuilt whenever the
 * subject moved. But the SDK refuses a port whose type is acceptsAnyFlatbuffer,
 * so "raw text plus a typed descriptor" cannot be two ports: the text port
 * would have no concrete SDS identity to declare.
 *
 * So the frame is ONE port carrying BOTH, in this order:
 *
 *     [u32le n][ $NCD flatbuffer, n bytes ][ the message's exact bytes ]
 *
 * which is exactly a size-prefixed `$NCD` buffer with the described file
 * appended — the same frame `files/orbit-products` reads, deliberately, because
 * one frame shape for "a descriptor and the file it describes" is worth more
 * than a shape tuned per package. The size prefix is self-describing, so the
 * boundary is read out of the frame rather than agreed out of band, and
 * SOURCE_SHA256 / SOURCE_BYTE_LENGTH make the pairing PROVABLE: when the caller
 * declared either, it is checked against the trailing bytes and a mismatch is
 * refused. That check is the whole reason the schema carries the hash, and
 * without the bytes in the frame this module would need a fetch capability to
 * do its job, which a pure parser must not have.
 *
 * `ncdContainerFormat` already names both members — CCSDS_AEM_KVN and
 * CCSDS_TDM_KVN — so this is the use they were minted for, not a
 * reinterpretation of the record.
 *
 * WHY FOUR METHODS AND NOT ONE
 *
 * A single `read_message` would have to leave one of two record output ports
 * unpopulated on every invoke, which makes both ports optional and makes the
 * contract "one of these, we will not say which" — a caller then has to branch
 * on what came back instead of on what it asked for. Naming the message in the
 * method makes every port required and every invoke's shape known before it
 * runs. The descriptor's FORMAT is still checked against the method, so asking
 * for the wrong one is refused rather than reinterpreted.
 *
 * WHAT IS LOST IS NAMED BEFORE IT IS LOST
 *
 * The projection reports every keyword and comment the record has no field for.
 * Those reports are not errors — refusing them would refuse three of the five
 * published Blue Book examples — but they are not silent either: the manifest's
 * port descriptions name the exact set at this SDS pin, and
 * `tests/ccsds_projection_native.cpp` pins the count per fixture so it cannot
 * grow without a test failing.
 *
 * NO TIME MATH AND NO JSON. Epochs stay the text the file wrote, for kvn.hpp's
 * reason: converting them needs the leap-second table `foundation/time` owns.
 * Both surfaces here are FlatBuffers, so every key is a generated accessor name
 * and none can be hand-typed.
 */

#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <memory>
#include <string>
#include <vector>

#include "space_data_module_invoke.h"

#include "sha256.hpp"
#include "aem_projection.hpp"
#include "tdm_projection.hpp"

namespace {

uint32_t read_u32le(const uint8_t* p) {
    return static_cast<uint32_t>(p[0]) | (static_cast<uint32_t>(p[1]) << 8) |
           (static_cast<uint32_t>(p[2]) << 16) | (static_cast<uint32_t>(p[3]) << 24);
}

std::string lower_hex(const std::string& s) {
    std::string out;
    out.reserve(s.size());
    for (char c : s) out.push_back(c >= 'A' && c <= 'F' ? static_cast<char>(c + 32) : c);
    return out;
}

/* ------------------------------------------------------------------------ */
/* The incoming frame                                                        */
/* ------------------------------------------------------------------------ */

struct MessageFrame {
    std::vector<uint8_t> descriptor_bytes;
    const NCD* descriptor = nullptr;
    const uint8_t* body = nullptr;
    size_t body_length = 0;
};

/* Returns 0 on success, or an invoke status; sets the plugin error itself. */
int32_t decode_message_frame(const char* method, ncdContainerFormat expected, MessageFrame* out) {
    const int32_t index = plugin_find_input_index("message", 0);
    const plugin_input_frame_t* frame =
        index >= 0 ? plugin_get_input_frame(static_cast<uint32_t>(index)) : nullptr;
    if (!frame || !frame->payload || frame->payload_length == 0) {
        char message[256];
        std::snprintf(message, sizeof(message), "%s requires a frame on port \"message\".", method);
        plugin_set_error("missing-message-frame", message);
        return 400;
    }

    const uint8_t* payload = frame->payload;
    const size_t payload_length = static_cast<size_t>(frame->payload_length);
    if (payload_length < 8) {
        plugin_set_error("malformed-message-frame",
                         "The frame is too short to hold a size-prefixed $NCD descriptor.");
        return 400;
    }

    const uint32_t descriptor_length = read_u32le(payload);
    /* The prefix is the descriptor's length, so 4 + it is where the message
     * starts. A prefix that overruns the frame is a frame that is not what it
     * declares, and is refused before anything reads past it. */
    if (static_cast<uint64_t>(descriptor_length) + 4u > payload_length) {
        plugin_set_error("malformed-message-frame",
                         "The $NCD size prefix overruns the frame; the descriptor and the "
                         "message bytes must arrive in one frame as "
                         "[u32le n][$NCD][message].");
        return 400;
    }

    const size_t prefixed_length = 4u + static_cast<size_t>(descriptor_length);
    out->descriptor_bytes.assign(payload, payload + prefixed_length);
    ::flatbuffers::Verifier verifier(out->descriptor_bytes.data(), out->descriptor_bytes.size());
    if (!::flatbuffers::BufferHasIdentifier(out->descriptor_bytes.data(), NCDIdentifier(), true) ||
        !VerifySizePrefixedNCDBuffer(verifier)) {
        plugin_set_error("bad-ncd",
                         "The frame does not open with a verifiable size-prefixed $NCD buffer.");
        return 400;
    }
    out->descriptor = GetSizePrefixedNCD(out->descriptor_bytes.data());

    out->body = payload + prefixed_length;
    out->body_length = payload_length - prefixed_length;
    if (out->body_length == 0) {
        plugin_set_error("missing-message-bytes",
                         "The frame carries an $NCD descriptor and no message. $NCD describes a "
                         "file rather than carrying one, so the described bytes must follow the "
                         "descriptor in the same frame; this module has no fetch capability and "
                         "will not resolve SOURCE_CID on its own.");
        return 400;
    }

    /* The declared identity is checked against the bytes that arrived, not
     * assumed to match them. This is what SOURCE_SHA256 is for. */
    if (out->descriptor->SOURCE_BYTE_LENGTH() != 0 &&
        out->descriptor->SOURCE_BYTE_LENGTH() != static_cast<uint64_t>(out->body_length)) {
        char message[256];
        std::snprintf(message, sizeof(message),
                      "SOURCE_BYTE_LENGTH is %llu but the frame carries %llu message bytes.",
                      static_cast<unsigned long long>(out->descriptor->SOURCE_BYTE_LENGTH()),
                      static_cast<unsigned long long>(out->body_length));
        plugin_set_error("descriptor-length-mismatch", message);
        return 400;
    }
    if (out->descriptor->SOURCE_SHA256() && out->descriptor->SOURCE_SHA256()->size() > 0) {
        const std::string declared = lower_hex(out->descriptor->SOURCE_SHA256()->str());
        const std::string actual = ephem::sha256_hex(out->body, out->body_length);
        if (declared != actual) {
            char message[256];
            std::snprintf(message, sizeof(message),
                          "SOURCE_SHA256 declares %.16s... but the message bytes hash to "
                          "%.16s...; the descriptor does not describe this file.",
                          declared.c_str(), actual.c_str());
            plugin_set_error("descriptor-hash-mismatch", message);
            return 400;
        }
    }

    /* A declared FORMAT that names the OTHER CCSDS message is a caller that
     * asked for the wrong method, not a file to reinterpret. UNSPECIFIED is the
     * caller saying it does not know, which is allowed. */
    const ncdContainerFormat declared_format = out->descriptor->FORMAT();
    if (declared_format != ncdContainerFormat::UNSPECIFIED && declared_format != expected) {
        char message[256];
        std::snprintf(message, sizeof(message),
                      "%s reads %s, but the descriptor declares FORMAT %s.", method,
                      EnumNamencdContainerFormat(expected),
                      EnumNamencdContainerFormat(declared_format));
        plugin_set_error("format-mismatch", message);
        return 400;
    }
    return 0;
}

/* ------------------------------------------------------------------------ */
/* The descriptor                                                            */
/* ------------------------------------------------------------------------ */

/*
 * Only what the file said. PRODUCER, INTERNAL_FILE_NAME and SOURCE_CID are
 * facts a CCSDS keyword-value message has no keyword for, so they are carried
 * through from the caller's descriptor when it stated them and left empty
 * otherwise — never synthesised from ORIGINATOR, which is a different fact.
 *
 * START_TIME and STOP_TIME come from the FIRST and LAST segment rather than
 * from a comparison across all of them: both books require segments in time
 * order, and comparing epoch strings would mean deciding whether
 * `2005-184T11:12:23` sorts against `1996-11-28T21:29:07`, which is time math
 * this package does not do.
 */
void fill_common_descriptor(const kvn::Document& doc, const std::vector<kvn::Entry>& header,
                            const uint8_t* body, size_t body_length, const NCD* incoming,
                            ncdContainerFormat format, const char* version_key, NCDT* out) {
    out->FORMAT = format;
    const kvn::Entry* vers = kvn::find(header, version_key);
    if (vers) out->FORMAT_VERSION = vers->value;
    const kvn::Entry* originator = kvn::find(header, "ORIGINATOR");
    if (originator) out->ORIGINATOR = originator->value;
    const kvn::Entry* creation = kvn::find(header, "CREATION_DATE");
    if (creation) out->CREATION_DATE = creation->value;

    for (size_t i = 0; i < header.size(); ++i) {
        for (size_t c = 0; c < header[i].comments_before.size(); ++c) {
            out->COMMENT_AREA.push_back(header[i].comments_before[c]);
        }
        if (header[i].is_standalone_comment) out->COMMENT_AREA.push_back(header[i].value);
    }

    if (!doc.segments.empty()) {
        const kvn::Entry* time_system = kvn::find(doc.segments[0].metadata, "TIME_SYSTEM");
        if (time_system) out->NATIVE_TIME_SYSTEM = time_system->value;
        const kvn::Entry* start = kvn::find(doc.segments[0].metadata, "START_TIME");
        if (start) out->START_TIME = start->value;
        const kvn::Entry* stop =
            kvn::find(doc.segments[doc.segments.size() - 1].metadata, "STOP_TIME");
        if (stop) out->STOP_TIME = stop->value;
    }

    if (incoming) {
        if (incoming->PRODUCER()) out->PRODUCER = incoming->PRODUCER()->str();
        if (incoming->INTERNAL_FILE_NAME()) {
            out->INTERNAL_FILE_NAME = incoming->INTERNAL_FILE_NAME()->str();
        }
        if (incoming->SOURCE_CID()) out->SOURCE_CID = incoming->SOURCE_CID()->str();
    }

    out->SOURCE_BYTE_LENGTH = static_cast<uint64_t>(body_length);
    out->SOURCE_SHA256 = ephem::sha256_hex(body, body_length);
}

int32_t push_descriptor(const NCDT& descriptor) {
    ::flatbuffers::FlatBufferBuilder fbb(4096);
    fbb.FinishSizePrefixed(CreateNCD(fbb, &descriptor), NCDIdentifier());
    const int32_t pushed = plugin_push_output_ex(
        "descriptor", "NCD.fbs", "$NCD", PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY, "NCD", 0, 8,
        fbb.GetBufferPointer(), static_cast<uint32_t>(fbb.GetSize()));
    return pushed < 0 ? 500 : 0;
}

/* The frame both write methods emit: the descriptor, then the text it
 * describes, in one buffer. Built here so the two writers cannot disagree
 * about the layout the readers above parse. */
int32_t push_message_frame(const NCDT& descriptor, const std::string& text) {
    ::flatbuffers::FlatBufferBuilder fbb(4096);
    fbb.FinishSizePrefixed(CreateNCD(fbb, &descriptor), NCDIdentifier());
    std::vector<uint8_t> frame;
    frame.reserve(fbb.GetSize() + text.size());
    frame.insert(frame.end(), fbb.GetBufferPointer(), fbb.GetBufferPointer() + fbb.GetSize());
    frame.insert(frame.end(), text.begin(), text.end());
    const int32_t pushed = plugin_push_output_ex(
        "message", "NCD.fbs", "$NCD", PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY, "NCD", 0, 8,
        frame.data(), static_cast<uint32_t>(frame.size()));
    return pushed < 0 ? 500 : 0;
}

/* ------------------------------------------------------------------------ */
/* Parsing the frame's text                                                  */
/* ------------------------------------------------------------------------ */

int32_t parse_body(const MessageFrame& frame, const char* expected_type, kvn::Document* doc) {
    const kvn::Status ks = kvn::parse(reinterpret_cast<const char*>(frame.body),
                                      frame.body_length, doc);
    if (ks != kvn::Status::Ok) {
        char message[256];
        std::snprintf(message, sizeof(message),
                      "The message bytes are not readable keyword-value notation (%s).",
                      kvn::status_name(ks));
        plugin_set_error(kvn::status_name(ks), message);
        return 422;
    }
    if (doc->message_type != expected_type) {
        char message[256];
        std::snprintf(message, sizeof(message),
                      "The frame carries a CCSDS_%s_VERS message, not CCSDS_%s_VERS.",
                      doc->message_type.empty() ? "?" : doc->message_type.c_str(), expected_type);
        plugin_set_error("wrong-message-type", message);
        return 422;
    }
    return 0;
}

/* The record record-side input frame for the two write methods. */
const plugin_input_frame_t* record_frame(const char* port, const char* method) {
    const int32_t index = plugin_find_input_index(port, 0);
    const plugin_input_frame_t* frame =
        index >= 0 ? plugin_get_input_frame(static_cast<uint32_t>(index)) : nullptr;
    if (!frame || !frame->payload || frame->payload_length == 0) {
        char message[256];
        std::snprintf(message, sizeof(message), "%s requires a frame on port \"%s\".", method,
                      port);
        plugin_set_error("missing-record-frame", message);
    }
    return frame;
}

}  // namespace

extern "C" {

int read_aem(void) {
    MessageFrame frame;
    const int32_t rc =
        decode_message_frame("read_aem", ncdContainerFormat::CCSDS_AEM_KVN, &frame);
    if (rc != 0) return rc;

    kvn::Document doc;
    const int32_t parsed = parse_body(frame, "AEM", &doc);
    if (parsed != 0) return parsed;

    ccsds::aem::Message view;
    ccsds::aem::Fault fault;
    const ccsds::aem::Status vs = ccsds::aem::from_document(doc, &view, &fault);
    if (vs != ccsds::aem::Status::Ok) {
        char message[256];
        std::snprintf(message, sizeof(message),
                      "Segment %zu row %zu: expected %zu attitude components, found %zu.",
                      fault.segment, fault.row, fault.expected, fault.actual);
        plugin_set_error(ccsds::aem::status_name(vs), message);
        return 422;
    }

    ::AEMT record;
    ccsds::aem::ProjectionReport report;
    const ccsds::aem::ProjectionStatus ps = ccsds::aem::to_record(view, &record, &report);
    if (ps != ccsds::aem::ProjectionStatus::Ok) {
        char message[256];
        std::snprintf(message, sizeof(message),
                      "Segment %zu row %zu could not be projected onto $AEM.", report.segment,
                      report.row);
        plugin_set_error(ccsds::aem::projection_status_name(ps), message);
        return 422;
    }

    ::flatbuffers::FlatBufferBuilder fbb(65536);
    fbb.FinishSizePrefixed(CreateAEM(fbb, &record), AEMIdentifier());
    if (plugin_push_output_ex("attitude", "AEM.fbs", "$AEM",
                              PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY, "AEM", 0, 8,
                              fbb.GetBufferPointer(),
                              static_cast<uint32_t>(fbb.GetSize())) < 0) {
        return 500;
    }

    NCDT descriptor;
    fill_common_descriptor(doc, view.header, frame.body, frame.body_length, frame.descriptor,
                           ncdContainerFormat::CCSDS_AEM_KVN, "CCSDS_AEM_VERS", &descriptor);
    return push_descriptor(descriptor);
}

int read_tdm(void) {
    MessageFrame frame;
    const int32_t rc =
        decode_message_frame("read_tdm", ncdContainerFormat::CCSDS_TDM_KVN, &frame);
    if (rc != 0) return rc;

    kvn::Document doc;
    const int32_t parsed = parse_body(frame, "TDM", &doc);
    if (parsed != 0) return parsed;

    ccsds::tdm::Message view;
    ccsds::tdm::Fault fault;
    const ccsds::tdm::Status vs = ccsds::tdm::from_document(doc, &view, &fault);
    if (vs != ccsds::tdm::Status::Ok) {
        char message[256];
        std::snprintf(message, sizeof(message), "Segment %zu observation %zu is not readable.",
                      fault.segment, fault.observation);
        plugin_set_error(ccsds::tdm::status_name(vs), message);
        return 422;
    }

    ::TDMT record;
    ccsds::tdm::ProjectionReport report;
    const ccsds::tdm::ProjectionStatus ps = ccsds::tdm::to_record(view, &record, &report);
    if (ps != ccsds::tdm::ProjectionStatus::Ok) {
        char message[256];
        std::snprintf(message, sizeof(message),
                      "Segment %zu observation %zu could not be projected onto $TDM.",
                      report.segment, report.observation);
        plugin_set_error(ccsds::tdm::projection_status_name(ps), message);
        return 422;
    }

    ::flatbuffers::FlatBufferBuilder fbb(65536);
    fbb.FinishSizePrefixed(CreateTDM(fbb, &record), TDMIdentifier());
    if (plugin_push_output_ex("tracking", "TDM.fbs", "$TDM",
                              PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY, "TDM", 0, 8,
                              fbb.GetBufferPointer(),
                              static_cast<uint32_t>(fbb.GetSize())) < 0) {
        return 500;
    }

    NCDT descriptor;
    fill_common_descriptor(doc, view.header, frame.body, frame.body_length, frame.descriptor,
                           ncdContainerFormat::CCSDS_TDM_KVN, "CCSDS_TDM_VERS", &descriptor);
    if (!doc.segments.empty()) {
        const kvn::Entry* reference_frame =
            kvn::find(doc.segments[0].metadata, "REFERENCE_FRAME");
        if (reference_frame) descriptor.NATIVE_FRAME_NAME = reference_frame->value;
    }
    return push_descriptor(descriptor);
}

int write_aem(void) {
    const plugin_input_frame_t* frame = record_frame("attitude", "write_aem");
    if (!frame) return 400;

    ::flatbuffers::Verifier verifier(frame->payload, frame->payload_length);
    const bool prefixed = ::flatbuffers::BufferHasIdentifier(frame->payload, AEMIdentifier(), true);
    if (!(prefixed ? VerifySizePrefixedAEMBuffer(verifier) : VerifyAEMBuffer(verifier))) {
        plugin_set_error("bad-aem", "The frame is not a verifiable $AEM buffer.");
        return 400;
    }
    ::AEMT record;
    (prefixed ? GetSizePrefixedAEM(frame->payload) : GetAEM(frame->payload))->UnPackTo(&record);

    ccsds::aem::Message view;
    ccsds::aem::ProjectionReport report;
    const ccsds::aem::ProjectionStatus ps = ccsds::aem::from_record(record, &view, &report);
    if (ps != ccsds::aem::ProjectionStatus::Ok) {
        char message[256];
        std::snprintf(message, sizeof(message),
                      "Segment %zu row %zu could not be read back from $AEM.", report.segment,
                      report.row);
        plugin_set_error(ccsds::aem::projection_status_name(ps), message);
        return 422;
    }

    kvn::Document doc;
    if (ccsds::aem::to_document(view, &doc) != ccsds::aem::Status::Ok) {
        plugin_set_error("not-aem", "The record did not rebuild an AEM document.");
        return 422;
    }
    std::string text;
    if (kvn::serialize(doc, &text) != kvn::Status::Ok) {
        plugin_set_error("malformed", "The AEM document could not be serialized.");
        return 500;
    }

    NCDT descriptor;
    fill_common_descriptor(doc, doc.header, reinterpret_cast<const uint8_t*>(text.data()),
                           text.size(), nullptr, ncdContainerFormat::CCSDS_AEM_KVN,
                           "CCSDS_AEM_VERS", &descriptor);
    return push_message_frame(descriptor, text);
}

int write_tdm(void) {
    const plugin_input_frame_t* frame = record_frame("tracking", "write_tdm");
    if (!frame) return 400;

    ::flatbuffers::Verifier verifier(frame->payload, frame->payload_length);
    const bool prefixed = ::flatbuffers::BufferHasIdentifier(frame->payload, TDMIdentifier(), true);
    if (!(prefixed ? VerifySizePrefixedTDMBuffer(verifier) : VerifyTDMBuffer(verifier))) {
        plugin_set_error("bad-tdm", "The frame is not a verifiable $TDM buffer.");
        return 400;
    }
    ::TDMT record;
    (prefixed ? GetSizePrefixedTDM(frame->payload) : GetTDM(frame->payload))->UnPackTo(&record);

    ccsds::tdm::Message view;
    ccsds::tdm::ProjectionReport report;
    const ccsds::tdm::ProjectionStatus ps = ccsds::tdm::from_record(record, &view, &report);
    if (ps != ccsds::tdm::ProjectionStatus::Ok) {
        char message[256];
        std::snprintf(message, sizeof(message),
                      "Segment %zu observation %zu could not be read back from $TDM.",
                      report.segment, report.observation);
        plugin_set_error(ccsds::tdm::projection_status_name(ps), message);
        return 422;
    }

    kvn::Document doc;
    if (ccsds::tdm::to_document(view, &doc) != ccsds::tdm::Status::Ok) {
        plugin_set_error("not-tdm", "The record did not rebuild a TDM document.");
        return 422;
    }
    std::string text;
    if (kvn::serialize(doc, &text) != kvn::Status::Ok) {
        plugin_set_error("malformed", "The TDM document could not be serialized.");
        return 500;
    }

    NCDT descriptor;
    fill_common_descriptor(doc, doc.header, reinterpret_cast<const uint8_t*>(text.data()),
                           text.size(), nullptr, ncdContainerFormat::CCSDS_TDM_KVN,
                           "CCSDS_TDM_VERS", &descriptor);
    return push_message_frame(descriptor, text);
}

}  // extern "C"
