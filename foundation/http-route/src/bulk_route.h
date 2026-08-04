/*
 * foundation/http-route — per-schema bulk route parsing.
 *
 * WHY THIS IS ITS OWN HEADER (2026-08-04, sdn-data-retrieval-rfb-bulk-route).
 *
 * The data-retrieval flow served exactly one record route, "/omm/bulk", from a
 * hard-coded string compare. The node stores far more than $OMM — the live RF
 * catalogue ($RFB, 5,289 SatNOGS emitter records) had no retrieval route at all
 * — and adding one string compare per standard is how a routing table becomes a
 * list nobody maintains.
 *
 * The route is therefore PARSED, not enumerated: "<code>/bulk" names the SDS
 * standard whose records are being read. Which standards a node actually serves
 * is decided downstream (the retrieval node queries the store; a standard with
 * no rows answers an empty stream) and which are readable without a session is
 * decided by the host's per-schema anonymous data plane. This function decides
 * nothing but the SHAPE of the path.
 *
 * It lives in a header with no SDK, flatbuffers or wasm dependency so it can be
 * compiled and tested natively — which matters right now, because the flow
 * bundle cannot be relinked until the SDK's descriptor-ABI migration lands
 * (mod-flow-bundles-descriptor-abi-gen2).
 */

#ifndef SDN_HTTP_ROUTE_BULK_ROUTE_H
#define SDN_HTTP_ROUTE_BULK_ROUTE_H

#include <cstddef>
#include <string>

namespace sdn_http_route {

// Longest SDS standard code accepted. Real codes are 3-4 characters; the bound
// exists so a pathological path cannot become a schema name.
constexpr std::size_t kMaxStandardCodeLength = 8;

// bulk_route_schema returns the SDS schema file name ("RFB.fbs") for a request
// path whose last two segments are "<code>/bulk", or "" when the path is not a
// per-schema bulk read.
//
// Mount-agnostic by design: the flow does not know its own mount path, so the
// match is on the SUFFIX ("/api/v1/data/rfb/bulk" and "/test/data/rfb/bulk"
// both yield RFB.fbs).
inline std::string bulk_route_schema(const std::string& path) {
    static const std::string kBulk = "/bulk";
    if (path.size() <= kBulk.size()) return "";
    if (path.compare(path.size() - kBulk.size(), kBulk.size(), kBulk) != 0) return "";

    const std::size_t code_end = path.size() - kBulk.size();
    const std::size_t slash = path.rfind('/', code_end - 1);
    if (slash == std::string::npos) return "";

    const std::size_t code_begin = slash + 1;
    if (code_begin >= code_end) return "";  // ".../bulk" with no code segment
    const std::size_t length = code_end - code_begin;
    if (length > kMaxStandardCodeLength) return "";

    std::string code;
    code.reserve(length + 4);
    for (std::size_t i = code_begin; i < code_end; i++) {
        const char c = path[i];
        if (c >= 'a' && c <= 'z') {
            code.push_back(static_cast<char>(c - 'a' + 'A'));
        } else if ((c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')) {
            code.push_back(c);
        } else {
            // Anything else (percent-escapes, dots, dashes) is not a standard
            // code. Refusing is what keeps this from becoming a path oracle.
            return "";
        }
    }
    code += ".fbs";
    return code;
}

// json_encode_available reports whether the flow can present this standard's
// records as JSON.
//
// The composed flow's json branch is foundation/omm-json — an $OMM encoder. A
// non-OMM stream sent through it would be decoded as OMM and emitted as
// confident nonsense, which is worse than a refusal. Until a schema-generic
// encoder node exists, ?format=json is honoured for $OMM alone and every other
// standard is told so explicitly.
inline bool json_encode_available(const std::string& schema) {
    return schema == "OMM.fbs";
}

}  // namespace sdn_http_route

#endif  // SDN_HTTP_ROUTE_BULK_ROUTE_H
