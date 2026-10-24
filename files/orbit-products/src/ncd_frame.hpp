/*
 * files/orbit-products — the $NCD frame every reader takes.
 *
 * `$NCD` describes a file and does not carry it, and the SDK refuses a port typed
 * "any FlatBuffer", so a file travels as ONE frame:
 *
 *     [u32le n][ $NCD flatbuffer, n bytes ][ the file's exact bytes ]
 *
 * a size-prefixed $NCD with the described file appended. The size prefix gives
 * the boundary, and SOURCE_SHA256 / SOURCE_BYTE_LENGTH, when the caller declares
 * them, are CHECKED against the trailing bytes. The $NCD is also the REQUEST:
 * every option of a reader travels in it (owner, 2026-10-24: "We need to be able
 * to pass configurations using a flatbuffer message").
 *
 * One definition, included by every module that reads such a frame
 * (files/orbit-products and files/rinex), so the framing cannot drift between
 * them.
 */

#ifndef ORBIT_PRODUCTS_NCD_FRAME_HPP
#define ORBIT_PRODUCTS_NCD_FRAME_HPP

#include <cstdint>
#include <cstdio>
#include <string>
#include <vector>

#include "space_data_module_invoke.h"

#include "sha256.hpp"

namespace {

uint32_t read_u32le(const uint8_t* p) {
    return static_cast<uint32_t>(p[0]) | (static_cast<uint32_t>(p[1]) << 8) |
           (static_cast<uint32_t>(p[2]) << 16) | (static_cast<uint32_t>(p[3]) << 24);
}

/* ------------------------------------------------------------------------ */
/* The input frame                                                           */
/* ------------------------------------------------------------------------ */

struct ContainerFrame {
    /* An aligned copy of `[u32le n][$NCD]`. FlatBuffers built size-prefixed
     * align their 8-byte scalars counting the prefix, so the descriptor must
     * sit at an allocator-aligned address for the accessors to read it. The
     * container BODY is left where it arrived: every reader here goes through
     * memcpy, so it has no alignment requirement of its own and copying a
     * half-gigabyte kernel to satisfy one that does not exist would be the
     * module's whole runtime cost. */
    std::vector<uint8_t> descriptor_bytes;
    const NCD* descriptor = nullptr;
    const uint8_t* body = nullptr;
    size_t body_length = 0;
};

/* Returns 0 on success, or an invoke status; sets the plugin error itself.
 * `port` is the input port the frame arrives on: "container" for the file a
 * method reads, and a method with a second framed file (a CK's spacecraft clock
 * kernel) names that port too. */
int32_t decode_container_frame(const char* method, ContainerFrame* out,
                               const char* port = "container") {
    const int32_t index = plugin_find_input_index(port, 0);
    const plugin_input_frame_t* frame =
        index >= 0 ? plugin_get_input_frame(static_cast<uint32_t>(index)) : nullptr;
    if (!frame || !frame->payload || frame->payload_length == 0) {
        char message[256];
        std::snprintf(message, sizeof(message),
                      "%s requires a frame on port \"%s\".", method, port);
        plugin_set_error("missing-container-frame", message);
        return 400;
    }

    const uint8_t* payload = frame->payload;
    const size_t payload_length = static_cast<size_t>(frame->payload_length);
    if (payload_length < 12) {
        plugin_set_error("malformed-container-frame",
                         "The frame is too short to hold a size-prefixed $NCD descriptor.");
        return 400;
    }

    const uint32_t descriptor_length = read_u32le(payload);
    /* The prefix is the descriptor's length, so 4 + it is where the container
     * starts. A prefix that overruns the frame is a frame that is not what it
     * declares, and is refused before anything reads past it. */
    if (descriptor_length < 8 ||
        static_cast<uint64_t>(descriptor_length) + 4u > payload_length) {
        plugin_set_error("malformed-container-frame",
                         "The $NCD size prefix overruns the frame; the descriptor and the "
                         "container bytes must arrive in one frame as "
                         "[u32le n][$NCD][container].");
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
        plugin_set_error("missing-container-bytes",
                         "The frame carries an $NCD descriptor and no container. $NCD describes "
                         "a file rather than carrying one, so the described bytes must follow "
                         "the descriptor in the same frame; this module has no fetch capability "
                         "and will not resolve SOURCE_CID on its own.");
        return 400;
    }

    /* The declared identity is checked against the bytes that arrived, not
     * assumed to match them. This is what SOURCE_SHA256 is for. */
    if (out->descriptor->SOURCE_BYTE_LENGTH() != 0 &&
        out->descriptor->SOURCE_BYTE_LENGTH() != static_cast<uint64_t>(out->body_length)) {
        char message[256];
        std::snprintf(message, sizeof(message),
                      "SOURCE_BYTE_LENGTH is %llu but the frame carries %llu container bytes.",
                      static_cast<unsigned long long>(out->descriptor->SOURCE_BYTE_LENGTH()),
                      static_cast<unsigned long long>(out->body_length));
        plugin_set_error("descriptor-length-mismatch", message);
        return 400;
    }
    if (out->descriptor->SOURCE_SHA256() && out->descriptor->SOURCE_SHA256()->size() > 0) {
        const std::string declared = out->descriptor->SOURCE_SHA256()->str();
        std::string lowered;
        lowered.reserve(declared.size());
        for (char c : declared) {
            lowered.push_back(c >= 'A' && c <= 'F' ? static_cast<char>(c + 32) : c);
        }
        const std::string actual = ephem::sha256_hex(out->body, out->body_length);
        if (lowered != actual) {
            char message[256];
            std::snprintf(message, sizeof(message),
                          "SOURCE_SHA256 declares %.16s... but the container bytes hash to "
                          "%.16s...; the descriptor does not describe this file.",
                          lowered.c_str(), actual.c_str());
            plugin_set_error("descriptor-hash-mismatch", message);
            return 400;
        }
    }
    return 0;
}

}  // namespace

#endif  // ORBIT_PRODUCTS_NCD_FRAME_HPP
