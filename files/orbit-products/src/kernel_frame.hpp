#ifndef ORBIT_PRODUCTS_KERNEL_FRAME_HPP
#define ORBIT_PRODUCTS_KERNEL_FRAME_HPP

#include <cstdint>
#include <string>
#include <vector>
#include "NCD_generated.h"
#include "sha256.hpp"

namespace ephem {

// Same wire format as files/orbit-products: [u32le n][$NCD, n bytes][SPK].
// Only the descriptor is copied for FlatBuffer alignment. Kernel words stay
// in the invoke input buffer and must remain alive through every evaluation.
struct KernelFrame {
    std::vector<uint8_t> descriptor_bytes;
    const NCD* descriptor = nullptr;
    const uint8_t* body = nullptr;
    size_t body_length = 0;
};

inline bool decode_kernel_frame(const uint8_t* payload, size_t size,
                                KernelFrame* out, const char** error) {
    auto fail = [&](const char* message) {
        if (error) *error = message;
        return false;
    };
    if (!payload || !out || size < 12) return fail("Truncated kernel frame.");
    *out = KernelFrame{};
    const uint32_t n = static_cast<uint32_t>(payload[0]) |
        (static_cast<uint32_t>(payload[1]) << 8) |
        (static_cast<uint32_t>(payload[2]) << 16) |
        (static_cast<uint32_t>(payload[3]) << 24);
    if (n < 8 || n > 1024 * 1024 || static_cast<uint64_t>(n) + 4 >= size)
        return fail("Kernel frame requires an NCD descriptor of at most 1 MiB followed by SPK bytes.");
    const size_t prefix = static_cast<size_t>(n) + 4;
    out->descriptor_bytes.assign(payload, payload + prefix);
    ::flatbuffers::Verifier verifier(out->descriptor_bytes.data(), prefix);
    if (!::flatbuffers::BufferHasIdentifier(out->descriptor_bytes.data(), NCDIdentifier(), true) ||
        !VerifySizePrefixedNCDBuffer(verifier))
        return fail("Invalid size-prefixed NCD kernel descriptor.");
    out->descriptor = GetSizePrefixedNCD(out->descriptor_bytes.data());
    if (out->descriptor->FORMAT() != ncdContainerFormat::SPK_DAF)
        return fail("Kernel descriptor FORMAT must be SPK_DAF.");
    out->body = payload + prefix;
    out->body_length = size - prefix;
    const auto length = out->descriptor->SOURCE_BYTE_LENGTH();
    if (length && length != out->body_length)
        return fail("Kernel SOURCE_BYTE_LENGTH does not match the supplied bytes.");
    const auto* hash = out->descriptor->SOURCE_SHA256();
    if (hash && hash->size()) {
        std::string expected = hash->str();
        for (char& c : expected) if (c >= 'A' && c <= 'F') c += 'a' - 'A';
        if (expected != sha256_hex(out->body, out->body_length))
            return fail("Kernel SOURCE_SHA256 does not match the supplied bytes.");
    }
    return true;
}

} // namespace ephem
#endif
