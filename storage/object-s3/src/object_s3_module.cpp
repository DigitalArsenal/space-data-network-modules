/*
 * storage/object-s3 - one signer/parser module for every S3-compatible object store: Cloudflare R2, AWS S3, Backblaze
 * B2, MinIO, Wasabi, GCS interoperability (typed contracts 1.0: FlatBuffers only, every hostcall an SDS $PIV invocation
 * through sdm_piv).
 *
 * OWNER 2026-10-21, verbatim: "we need nodes to do that as well using modules that can be loaded (and credentials) into
 * SDN nodes, to update R2 but also any other storage, storage modules if they don't exist yet need to be separate and
 * then we do flows".
 *
 * WHAT IT IS. A request builder and a response reader. It never touches the network: it turns an operation task into a
 * SigV4-signed HttpRequest (HREQ) for hostcap/http-request, and turns the HttpResponse (HRSP) that comes back into a
 * result. The flow wires the two together, so the module holds no http capability and the credential has no path out
 * except the Authorization header of the request the flow routes to the http node.
 *
 * WHAT IT HOLDS. The READ grant on the credential lanes (secrets:storage_<store>) and the clock. The WRITE grant lives in
 * storage/credentials, a separate artifact, so this module can read a credential and can never replace or clear one.
 * The access key id and secret exist in this guest only for the instructions between secrets.get and the signature and
 * are wiped afterwards. The secret never appears in any output frame, CONTEXT, notice or log.
 *
 * METHODS (a DAG, because a flow has no loops; multipart is three stages and the state rides in HREQ CONTEXT):
 *   serve     request ($HTQ, the HTTP edge) -> task ($APR) + decision ($APR, refusals). The admin API of a node:
 *             PUT|GET|HEAD|DELETE .../objects/<store>/<bucket>/<key> and GET .../objects/<store>/<bucket> (list), the
 *             endpoint / region / style and the route options in the query string. The flow marks the mount NOT anonymous.
 *   sign      task ($APR) -> requests (HREQ) + result ($APR, refusals) + held ($APR)
 *             ROUTE put | get | head | delete | list. A put whose BODY exceeds multipartThreshold (16 MiB default)
 *             emits the CreateMultipartUpload request instead of the PUT, and the task itself on held.
 *   split     created (HRSP of the create) + object ($APR, held) -> requests (UploadPart x N) + result
 *   assemble  parts (HRSP x N) -> requests (CompleteMultipartUpload, or AbortMultipartUpload on any failure) + result
 *   finish    responses (HRSP) -> result ($APR) + listing ($FIL)
 *
 * TASK PARAMETERS (the $APR PARAMETERS): store (credential lane suffix, lane = storage_<store>), endpoint
 * (https://host[:port]; http only for loopback), region (default "auto"), bucket, key, style (path | virtual; default
 * path). freshRead=false drops the no-validator header (below). get: range ("bytes=a-b"), maxBytes. put: contentType, cacheControl, partSize (>= 5 MiB, default 16 MiB),
 * multipartThreshold, payload ("signed" | "unsigned"; default unsigned over https, signed over http). list: prefix, delimiter, maxKeys, continuationToken, startAfter.
 * date (YYYYMMDDTHHMMSSZ) fixes the signing time; absent, clock.nowIso is read once per invocation.
 *
 * RESULT ($APR): REQUEST_ID and ROUTE echoed, STATUS the HTTP status (502 when the exchange itself failed), ERROR_CODE
 * and ERROR_MESSAGE from the store's XML error, BODY the object bytes for get (a $FIL listing for list). PARAMETERS echo
 * store, bucket, key, the store's headers (etag, content-length, content-type, last-modified, content-range; as
 * PARAMETERS, not RESPONSE_HEADERS, so the HTTP responder does not apply them to the answer that carries the record) and
 * uploadId / parts / size for a multipart put, nextContinuationToken / isTruncated / keyCount for a list.
 */

#include <algorithm>
#include <cctype>
#include <array>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <map>
#include <memory>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "space_data_module_invoke.h"
#include "typedHostcall.hpp"
#include "HttpRequest_generated.h"
#include "HttpResponse_generated.h"

namespace {

namespace A = sdn::runtime::Aligned;
namespace R = sdn::runtime;

constexpr const char* kLanePrefix = "storage_";
constexpr uint64_t kMiB = 1024ull * 1024ull;
constexpr uint64_t kDefaultPartSize = 16 * kMiB;
constexpr uint64_t kMinPartSize = 5 * kMiB;
constexpr uint64_t kMaxParts = 10000;
constexpr uint64_t kDefaultThreshold = 16 * kMiB;
constexpr uint32_t kDefaultTimeoutMs = 300000;
// The Go node's http connector presents the ETag / Last-Modified it remembers for a URL as If-None-Match /
// If-Modified-Since on the next GET of that URL (a CelesTrak politeness feature) and delivers the 304 as an empty
// "unchanged" answer. "The module keeps its own headers when it sets either validator itself", so every GET names a
// validator no object can carry: the store answers the full response, which is what an object read wants.
constexpr const char* kNoValidator = "\"sdn-storage-object-s3-fresh-read\"";

// ── SHA-256 / HMAC-SHA-256 (FIPS 180-4, RFC 2104) ───────────────────────────────────────────────────────────────
struct Sha256 {
    uint32_t h[8];
    uint64_t length = 0;
    uint8_t block[64];
    size_t used = 0;
    Sha256() {
        static const uint32_t init[8] = {0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
                                         0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19};
        std::memcpy(h, init, sizeof h);
    }
    static uint32_t rotr(uint32_t x, uint32_t n) { return (x >> n) | (x << (32 - n)); }
    void compress(const uint8_t* p) {
        static const uint32_t k[64] = {
            0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
            0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
            0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
            0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
            0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
            0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
            0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
            0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2};
        uint32_t w[64];
        for (int i = 0; i < 16; ++i)
            w[i] = (static_cast<uint32_t>(p[i * 4]) << 24) | (static_cast<uint32_t>(p[i * 4 + 1]) << 16) |
                   (static_cast<uint32_t>(p[i * 4 + 2]) << 8) | static_cast<uint32_t>(p[i * 4 + 3]);
        for (int i = 16; i < 64; ++i) {
            const uint32_t s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >> 3);
            const uint32_t s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16] + s0 + w[i - 7] + s1;
        }
        uint32_t a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
        for (int i = 0; i < 64; ++i) {
            const uint32_t s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
            const uint32_t ch = (e & f) ^ (~e & g);
            const uint32_t t1 = hh + s1 + ch + k[i] + w[i];
            const uint32_t s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
            const uint32_t maj = (a & b) ^ (a & c) ^ (b & c);
            const uint32_t t2 = s0 + maj;
            hh = g; g = f; f = e; e = d + t1; d = c; c = b; b = a; a = t1 + t2;
        }
        h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
    }
    void update(const uint8_t* p, size_t n) {
        length += n;
        if (used) {
            const size_t take = std::min(n, sizeof block - used);
            std::memcpy(block + used, p, take);
            used += take; p += take; n -= take;
            if (used == sizeof block) { compress(block); used = 0; }
        }
        while (n >= 64) { compress(p); p += 64; n -= 64; }
        if (n) { std::memcpy(block, p, n); used = n; }
    }
    std::array<uint8_t, 32> final() {
        const uint64_t bits = length * 8;
        const uint8_t pad = 0x80;
        update(&pad, 1);
        const uint8_t zero = 0;
        while (used != 56) update(&zero, 1);
        uint8_t tail[8];
        for (int i = 0; i < 8; ++i) tail[i] = static_cast<uint8_t>(bits >> (56 - 8 * i));
        update(tail, 8);
        std::array<uint8_t, 32> out{};
        for (int i = 0; i < 8; ++i) {
            out[i * 4] = static_cast<uint8_t>(h[i] >> 24);
            out[i * 4 + 1] = static_cast<uint8_t>(h[i] >> 16);
            out[i * 4 + 2] = static_cast<uint8_t>(h[i] >> 8);
            out[i * 4 + 3] = static_cast<uint8_t>(h[i]);
        }
        return out;
    }
};

using Digest = std::array<uint8_t, 32>;

Digest sha256(const uint8_t* p, size_t n) {
    Sha256 s;
    s.update(p, n);
    return s.final();
}
Digest sha256(const std::string& s) { return sha256(reinterpret_cast<const uint8_t*>(s.data()), s.size()); }

Digest hmac_sha256(const uint8_t* key, size_t key_len, const uint8_t* msg, size_t msg_len) {
    uint8_t k[64] = {0};
    if (key_len > 64) {
        const Digest d = sha256(key, key_len);
        std::memcpy(k, d.data(), d.size());
    } else if (key_len) {
        std::memcpy(k, key, key_len);
    }
    uint8_t ipad[64], opad[64];
    for (int i = 0; i < 64; ++i) { ipad[i] = k[i] ^ 0x36; opad[i] = k[i] ^ 0x5c; }
    Sha256 inner;
    inner.update(ipad, 64);
    inner.update(msg, msg_len);
    const Digest ih = inner.final();
    Sha256 outer;
    outer.update(opad, 64);
    outer.update(ih.data(), ih.size());
    const Digest out = outer.final();
    std::memset(k, 0, sizeof k);
    return out;
}
Digest hmac_sha256(const Digest& key, const std::string& msg) {
    return hmac_sha256(key.data(), key.size(), reinterpret_cast<const uint8_t*>(msg.data()), msg.size());
}

std::string hex(const uint8_t* p, size_t n) {
    static const char* digits = "0123456789abcdef";
    std::string out;
    out.reserve(n * 2);
    for (size_t i = 0; i < n; ++i) { out += digits[p[i] >> 4]; out += digits[p[i] & 15]; }
    return out;
}
std::string hex(const Digest& d) { return hex(d.data(), d.size()); }

// Overwrite before release: a credential must not linger in the guest heap.
void wipe(std::string* s) {
    if (!s) return;
    for (char& c : *s) c = '\0';
    s->clear();
}

// RFC 3986 unreserved characters pass; everything else is %XX. keep_slash leaves '/' for path segments.
std::string uri_encode(std::string_view in, bool keep_slash) {
    static const char* digits = "0123456789ABCDEF";
    std::string out;
    out.reserve(in.size() * 3);
    for (const unsigned char c : in) {
        if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-' || c == '_' ||
            c == '.' || c == '~' || (keep_slash && c == '/')) {
            out += static_cast<char>(c);
        } else {
            out += '%';
            out += digits[c >> 4];
            out += digits[c & 15];
        }
    }
    return out;
}

std::string lower(std::string_view s) {
    std::string out(s);
    std::transform(out.begin(), out.end(), out.begin(), [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    return out;
}

std::string trim(std::string_view s) {
    size_t a = 0, b = s.size();
    while (a < b && (s[a] == ' ' || s[a] == '\t')) ++a;
    while (b > a && (s[b - 1] == ' ' || s[b - 1] == '\t')) --b;
    return std::string(s.substr(a, b - a));
}

// ── XML (the handful of S3 response shapes; element text only) ──────────────────────────────────────────────────
std::string xml_unescape(std::string_view in) {
    std::string out;
    out.reserve(in.size());
    for (size_t i = 0; i < in.size(); ++i) {
        if (in[i] != '&') { out += in[i]; continue; }
        const size_t semi = in.find(';', i);
        if (semi == std::string_view::npos || semi - i > 8) { out += in[i]; continue; }
        const std::string_view ent = in.substr(i + 1, semi - i - 1);
        if (ent == "amp") out += '&';
        else if (ent == "lt") out += '<';
        else if (ent == "gt") out += '>';
        else if (ent == "quot") out += '"';
        else if (ent == "apos") out += '\'';
        else if (!ent.empty() && ent[0] == '#') {
            const long cp = (ent.size() > 1 && (ent[1] == 'x' || ent[1] == 'X')) ? std::strtol(std::string(ent.substr(2)).c_str(), nullptr, 16)
                                                                                  : std::strtol(std::string(ent.substr(1)).c_str(), nullptr, 10);
            if (cp < 0x80) out += static_cast<char>(cp);
            else if (cp < 0x800) { out += static_cast<char>(0xC0 | (cp >> 6)); out += static_cast<char>(0x80 | (cp & 0x3F)); }
            else if (cp < 0x10000) { out += static_cast<char>(0xE0 | (cp >> 12)); out += static_cast<char>(0x80 | ((cp >> 6) & 0x3F)); out += static_cast<char>(0x80 | (cp & 0x3F)); }
            else { out += static_cast<char>(0xF0 | (cp >> 18)); out += static_cast<char>(0x80 | ((cp >> 12) & 0x3F)); out += static_cast<char>(0x80 | ((cp >> 6) & 0x3F)); out += static_cast<char>(0x80 | (cp & 0x3F)); }
        } else { out += in[i]; continue; }
        i = semi;
    }
    return out;
}
std::string xml_escape(std::string_view in) {
    std::string out;
    for (const char c : in) {
        switch (c) {
            case '&': out += "&amp;"; break;
            case '<': out += "&lt;"; break;
            case '>': out += "&gt;"; break;
            case '"': out += "&quot;"; break;
            default: out += c;
        }
    }
    return out;
}
// The text of the first <tag>...</tag> at or after `from`; `end` receives the offset past the closing tag.
bool xml_text(std::string_view xml, const char* tag, size_t from, std::string* out, size_t* end = nullptr) {
    const std::string open = std::string("<") + tag + ">";
    const std::string close = std::string("</") + tag + ">";
    const size_t a = xml.find(open, from);
    if (a == std::string_view::npos) return false;
    const size_t b = xml.find(close, a + open.size());
    if (b == std::string_view::npos) return false;
    *out = xml_unescape(xml.substr(a + open.size(), b - a - open.size()));
    if (end) *end = b + close.size();
    return true;
}
std::string xml_first(std::string_view xml, const char* tag) {
    std::string out;
    xml_text(xml, tag, 0, &out);
    return out;
}

// 2026-10-21T18:22:11.123Z -> unix ms (proleptic Gregorian, UTC).
int64_t days_from_civil(int64_t y, unsigned m, unsigned d) {
    y -= m <= 2;
    const int64_t era = (y >= 0 ? y : y - 399) / 400;
    const unsigned yoe = static_cast<unsigned>(y - era * 400);
    const unsigned doy = (153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1;
    const unsigned doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    return era * 146097 + static_cast<int64_t>(doe) - 719468;
}
int64_t parse_iso_ms(std::string_view s) {
    if (s.size() < 19) return 0;
    auto num = [&](size_t at, size_t n) { return std::strtol(std::string(s.substr(at, n)).c_str(), nullptr, 10); };
    int64_t ms = ((days_from_civil(num(0, 4), static_cast<unsigned>(num(5, 2)), static_cast<unsigned>(num(8, 2))) * 24 + num(11, 2)) * 60 + num(14, 2)) * 60 + num(17, 2);
    ms *= 1000;
    if (s.size() > 20 && s[19] == '.') {
        std::string frac(s.substr(20));
        size_t digits = 0;
        while (digits < frac.size() && frac[digits] >= '0' && frac[digits] <= '9') ++digits;
        frac.resize(std::min<size_t>(digits, 3));
        while (frac.size() < 3) frac += '0';
        ms += std::strtol(frac.c_str(), nullptr, 10);
    }
    return ms;
}

// ── frames ───────────────────────────────────────────────────────────────────────────────────────────────────────
std::vector<const plugin_input_frame_t*> frames_on(const char* port) {
    std::vector<const plugin_input_frame_t*> out;
    for (uint32_t ordinal = 0;; ordinal++) {
        const int32_t idx = plugin_find_input_index(port, ordinal);
        if (idx < 0) break;
        const plugin_input_frame_t* f = plugin_get_input_frame(static_cast<uint32_t>(idx));
        if (f) out.push_back(f);
    }
    return out;
}

// The frames sit at any 4-byte boundary and carry up to hundreds of MiB: verify in place, never copy.
bool verify_unaligned(const uint8_t* p, size_t n, bool (*verify)(flatbuffers::Verifier&)) {
    flatbuffers::Verifier::Options options;
    options.check_alignment = false;
    options.max_size = FLATBUFFERS_MAX_BUFFER_SIZE;
    flatbuffers::Verifier verifier(p, n, options);
    return verify(verifier);
}
bool verify_apr(flatbuffers::Verifier& v) { return VerifyAPRBuffer(v); }
bool verify_hreq(flatbuffers::Verifier& v) { return R::VerifyHttpRequestBuffer(v); }
bool verify_hrsp(flatbuffers::Verifier& v) { return R::VerifyHttpResponseBuffer(v); }
bool has_identifier(const uint8_t* p, size_t n, const char* id) { return n >= 8 && std::memcmp(p + 4, id, 4) == 0; }

using Params = std::map<std::string, std::string>;

Params params_of(const APR* apr) {
    Params out;
    if (apr && apr->PARAMETERS())
        for (const auto* p : *apr->PARAMETERS())
            if (p && p->NAME()) out[p->NAME()->str()] = p->VALUE() ? p->VALUE()->str() : std::string();
    return out;
}
std::string get(const Params& p, const char* name, const char* fallback = "") {
    const auto it = p.find(name);
    return it == p.end() || it->second.empty() ? std::string(fallback) : it->second;
}
uint64_t get_u64(const Params& p, const char* name, uint64_t fallback) {
    const std::string v = get(p, name);
    if (v.empty()) return fallback;
    char* end = nullptr;
    const unsigned long long n = std::strtoull(v.c_str(), &end, 10);
    return end && *end == '\0' ? n : fallback;
}

std::unique_ptr<APRParameterT> parameter(const std::string& name, const std::string& value) {
    auto p = std::make_unique<APRParameterT>();
    p->NAME = name;
    p->VALUE = value;
    return p;
}

// ── the credential and the clock ────────────────────────────────────────────────────────────────────────────────
struct Credential {
    std::string access_key;
    std::string secret;
    bool ok = false;
    ~Credential() { wipe(&access_key); wipe(&secret); }
};

bool store_is_valid(const std::string& store) {
    if (store.empty() || store.size() > 24) return false;
    for (const char c : store)
        if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '_')) return false;
    return true;
}

// secrets.get is the module's only credential read. Cached for the invocation, wiped with it.
class Session {
public:
    ~Session() { for (auto& [store, c] : credentials_) { wipe(&c->access_key); wipe(&c->secret); } }
    const Credential* credential(const std::string& store) {
        const auto it = credentials_.find(store);
        if (it != credentials_.end()) return it->second->ok ? it->second.get() : nullptr;
        auto c = std::make_unique<Credential>();
        A::SecretParams sp{};
        sdm_piv::put(sp.ID, std::string(kLanePrefix) + store);
        sp.set_has_ID(true);
        const auto got = sdm_piv::call("secrets.get", "SecretParams", sp);
        if (got.ok()) {
            c->secret.assign(got.raw("secret"));
            if (const auto* result = got.result<A::SecretResult>("SecretResult")) c->access_key = result->USERNAME.str();
        }
        c->ok = !c->secret.empty() && !c->access_key.empty();
        const Credential* out = c->ok ? c.get() : nullptr;
        credentials_[store] = std::move(c);
        return out;
    }
    // YYYYMMDDTHHMMSSZ; a task's "date" parameter wins, else clock.nowIso once.
    std::string amz_date(const Params& p) {
        const std::string fixed = get(p, "date");
        if (fixed.size() == 16 && fixed[8] == 'T' && fixed[15] == 'Z') return fixed;
        if (!date_.empty()) return date_;
        const auto now = sdm_piv::call("clock.nowIso");
        if (now.ok()) {
            const std::string_view iso = now.raw("value");
            if (iso.size() >= 19 && iso[4] == '-' && iso[10] == 'T') {
                date_ = std::string(iso.substr(0, 4)) + std::string(iso.substr(5, 2)) + std::string(iso.substr(8, 2)) + "T" +
                        std::string(iso.substr(11, 2)) + std::string(iso.substr(14, 2)) + std::string(iso.substr(17, 2)) + "Z";
            }
        }
        return date_;
    }
private:
    std::map<std::string, std::unique_ptr<Credential>> credentials_;
    std::string date_;
};

// ── the target and the signature ────────────────────────────────────────────────────────────────────────────────
struct Target {
    std::string store, scheme, authority, region, bucket, key, style;
};

bool is_loopback(const std::string& authority) {
    return authority.rfind("localhost", 0) == 0 || authority.rfind("127.0.0.1", 0) == 0 || authority.rfind("[::1]", 0) == 0;
}

// Returns an error code ("" when fine); message is for the caller's result.
std::string target_from(const Params& p, bool need_key, Target* t, std::string* message) {
    t->store = get(p, "store");
    if (!store_is_valid(t->store)) { *message = "store must be 1-24 characters of a-z, 0-9, _"; return "bad-store"; }
    const std::string endpoint = get(p, "endpoint");
    const size_t scheme_end = endpoint.find("://");
    if (scheme_end == std::string::npos) { *message = "endpoint must be https://host[:port]"; return "bad-endpoint"; }
    t->scheme = lower(endpoint.substr(0, scheme_end));
    t->authority = endpoint.substr(scheme_end + 3);
    while (!t->authority.empty() && t->authority.back() == '/') t->authority.pop_back();
    if (t->authority.empty() || t->authority.find_first_of("/?#@ ") != std::string::npos) {
        *message = "endpoint must be a bare host[:port]";
        return "bad-endpoint";
    }
    if (t->scheme != "https" && !(t->scheme == "http" && is_loopback(t->authority))) {
        *message = "endpoint must be https (http only for loopback): a credential never travels in the clear";
        return "bad-endpoint";
    }
    t->region = get(p, "region", "auto");
    t->bucket = get(p, "bucket");
    if (t->bucket.empty() || t->bucket.find_first_of("/?# ") != std::string::npos) { *message = "bucket is required and is a bare name"; return "bad-bucket"; }
    t->key = get(p, "key");
    if (need_key && t->key.empty()) { *message = "key is required"; return "missing-key"; }
    t->style = get(p, "style", "path");
    if (t->style != "path" && t->style != "virtual") { *message = "style is path or virtual"; return "bad-style"; }
    return "";
}

// The payload hash a request signs: UNSIGNED-PAYLOAD over https for a body (what the AWS SDKs do; the transport is the
// integrity layer, and SHA-256 over every byte of a large object is the one expensive thing this guest does), the body's
// SHA-256 over plain http or when payload=signed asks for it. payload=unsigned forces it.
bool unsigned_payload(const Params& p, const Target& t, size_t body_len) {
    const std::string mode = get(p, "payload");
    if (mode == "unsigned") return true;
    if (mode == "signed") return false;
    return t.scheme == "https" && body_len > 0;
}

std::string host_header(const Target& t) { return t.style == "virtual" ? t.bucket + "." + t.authority : t.authority; }
std::string canonical_path(const Target& t, bool with_key) {
    std::string path = "/";
    if (t.style == "path") path += uri_encode(t.bucket, false) + (with_key ? "/" : "");
    if (with_key) path += uri_encode(t.key, true);
    if (t.style == "virtual" && !with_key) path = "/";
    return path;
}

using Query = std::vector<std::pair<std::string, std::string>>;
using HeaderList = std::vector<std::pair<std::string, std::string>>;  // lower-cased names

std::string canonical_query(Query q) {
    std::vector<std::pair<std::string, std::string>> enc;
    for (auto& [k, v] : q) enc.emplace_back(uri_encode(k, false), uri_encode(v, false));
    std::sort(enc.begin(), enc.end());
    std::string out;
    for (const auto& [k, v] : enc) {
        if (!out.empty()) out += '&';
        out += k + "=" + v;
    }
    return out;
}

struct Op {
    std::string method;
    bool with_key = true;
    Query query;
    HeaderList headers;   // extra signed headers (content-type, range, ...)
    const uint8_t* body = nullptr;
    size_t body_len = 0;
    bool unsigned_payload = false;
    uint32_t timeout_ms = kDefaultTimeoutMs;
    uint64_t max_bytes = 0;
    std::vector<uint8_t> context;
};

// One SigV4-signed HttpRequest; pushed on `requests`. The Authorization header is the only place the access key id
// appears; the secret signs and is gone.
int push_signed(const Target& t, const Credential& c, const std::string& amz_date, const Op& op) {
    const std::string host = host_header(t);
    const std::string payload_hash = op.unsigned_payload ? std::string("UNSIGNED-PAYLOAD") : hex(sha256(op.body ? op.body : reinterpret_cast<const uint8_t*>(""), op.body_len));
    HeaderList signed_headers = op.headers;
    signed_headers.emplace_back("host", host);
    signed_headers.emplace_back("x-amz-content-sha256", payload_hash);
    signed_headers.emplace_back("x-amz-date", amz_date);
    std::sort(signed_headers.begin(), signed_headers.end());
    std::string canonical_headers, names;
    for (const auto& [n, v] : signed_headers) {
        canonical_headers += n + ":" + trim(v) + "\n";
        if (!names.empty()) names += ';';
        names += n;
    }
    const std::string path = canonical_path(t, op.with_key);
    const std::string cq = canonical_query(op.query);
    const std::string canonical = op.method + "\n" + path + "\n" + cq + "\n" + canonical_headers + "\n" + names + "\n" + payload_hash;
    const std::string day = amz_date.substr(0, 8);
    const std::string scope = day + "/" + t.region + "/s3/aws4_request";
    const std::string to_sign = "AWS4-HMAC-SHA256\n" + amz_date + "\n" + scope + "\n" + hex(sha256(canonical));
    std::string seed = "AWS4" + c.secret;
    Digest k = hmac_sha256(reinterpret_cast<const uint8_t*>(seed.data()), seed.size(), reinterpret_cast<const uint8_t*>(day.data()), day.size());
    wipe(&seed);
    k = hmac_sha256(k, t.region);
    k = hmac_sha256(k, "s3");
    k = hmac_sha256(k, "aws4_request");
    const std::string signature = hex(hmac_sha256(k, to_sign));
    std::memset(k.data(), 0, k.size());

    R::HttpRequestT request;
    request.METHOD = op.method;
    request.URL = t.scheme + "://" + host + path + (cq.empty() ? "" : "?" + cq);
    for (const auto& [n, v] : signed_headers) {
        if (n == "host") continue;  // the http node derives Host from the URL, which is what was signed
        auto h = std::make_unique<R::HeaderT>();
        h->NAME = n;
        h->VALUE = v;
        request.HEADERS.push_back(std::move(h));
    }
    auto auth = std::make_unique<R::HeaderT>();
    auth->NAME = "authorization";
    auth->VALUE = "AWS4-HMAC-SHA256 Credential=" + c.access_key + "/" + scope + ", SignedHeaders=" + names + ", Signature=" + signature;
    request.HEADERS.push_back(std::move(auth));
    std::sort(request.HEADERS.begin(), request.HEADERS.end(), [](const auto& l, const auto& r) { return l->NAME < r->NAME; });
    if (op.body && op.body_len) request.BODY.assign(op.body, op.body + op.body_len);
    request.TIMEOUT_MS = op.timeout_ms;
    request.MAX_BYTES = op.max_bytes;
    request.CONTEXT = op.context;
    flatbuffers::FlatBufferBuilder b(1024 + request.BODY.size() + request.CONTEXT.size());
    R::FinishHttpRequestBuffer(b, R::HttpRequest::Pack(b, &request));
    wipe(&request.URL);
    for (auto& h : request.HEADERS) wipe(&h->VALUE);
    const int32_t pushed = plugin_push_output_ex("requests", "HttpRequest.fbs", R::HttpRequestIdentifier(),
                                                 PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, "HttpRequest", 0, 8,
                                                 b.GetBufferPointer(), static_cast<uint32_t>(b.GetSize()));
    return pushed < 0 ? 500 : 0;
}

// ── the result ($APR) ───────────────────────────────────────────────────────────────────────────────────────────
struct Outcome {
    std::string request_id, route;
    uint16_t status = 200;
    std::string error_code, error_message;
    Params echo;
    HeaderList headers;
    std::vector<uint8_t> body;
};

int push_result(const Outcome& o) {
    APRT result;
    result.REQUEST_ID = o.request_id;
    result.ROUTE = o.route;
    result.STATUS = o.status;
    result.ERROR_CODE = o.error_code;
    result.ERROR_MESSAGE = o.error_message;
    for (const auto& [k, v] : o.echo) result.PARAMETERS.push_back(parameter(k, v));
    // The store's headers ride PARAMETERS, never RESPONSE_HEADERS: foundation/http-respond puts RESPONSE_HEADERS on the HTTP
    // answer, and the store's content-length / etag / content-range would redescribe the $APR record the client receives.
    for (const auto& [k, v] : o.headers) result.PARAMETERS.push_back(parameter(k, v));
    result.BODY = o.body;
    flatbuffers::FlatBufferBuilder b(1024 + o.body.size());
    FinishAPRBuffer(b, APR::Pack(b, &result));
    return plugin_push_output_ex("result", "APR.fbs", APRIdentifier(), PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, "APR", 0, 8,
                                 b.GetBufferPointer(), static_cast<uint32_t>(b.GetSize())) < 0 ? 500 : 0;
}

Outcome refusal(const std::string& request_id, const std::string& route, uint16_t status, const std::string& code, const std::string& message, const Params& p) {
    Outcome o;
    o.request_id = request_id;
    o.route = route;
    o.status = status;
    o.error_code = code;
    o.error_message = message;
    for (const char* name : {"store", "bucket", "key"}) if (!get(p, name).empty()) o.echo[name] = get(p, name);
    return o;
}

// The run contract a request carries to its response: the task's identity and parameters, never its body.
std::vector<uint8_t> make_context(const std::string& request_id, const std::string& route, const Params& p, const Params& extra) {
    APRT ctx;
    ctx.REQUEST_ID = request_id;
    ctx.ROUTE = route;
    for (const auto& [k, v] : p) if (k.empty() || k[0] != '_') ctx.PARAMETERS.push_back(parameter(k, v));
    for (const auto& [k, v] : extra) ctx.PARAMETERS.push_back(parameter(k, v));
    flatbuffers::FlatBufferBuilder b(512);
    FinishAPRBuffer(b, APR::Pack(b, &ctx));
    return std::vector<uint8_t>(b.GetBufferPointer(), b.GetBufferPointer() + b.GetSize());
}

struct Context {
    std::string request_id, route;
    Params p;
    bool ok = false;
};
Context read_context(const flatbuffers::Vector<uint8_t>* raw) {
    Context c;
    if (!raw || raw->size() < 8 || !has_identifier(raw->data(), raw->size(), "$APR")) return c;
    if (!verify_unaligned(raw->data(), raw->size(), verify_apr)) return c;
    const APR* apr = GetAPR(raw->data());
    c.request_id = apr->REQUEST_ID() ? apr->REQUEST_ID()->str() : std::string();
    c.route = apr->ROUTE() ? apr->ROUTE()->str() : std::string();
    c.p = params_of(apr);
    c.ok = true;
    return c;
}

std::string identity(const std::string& request_id, const Params& p) {
    return request_id + "\x1f" + get(p, "store") + "\x1f" + get(p, "bucket") + "\x1f" + get(p, "key");
}

// A task's request id: the caller's REQUEST_ID, else the target itself.
std::string request_id_of(const APR* apr, const Params& p) {
    if (apr->REQUEST_ID() && apr->REQUEST_ID()->size()) return apr->REQUEST_ID()->str();
    return get(p, "store") + "/" + get(p, "bucket") + "/" + get(p, "key");
}

HeaderList put_headers(const Params& p) {
    HeaderList h;
    if (!get(p, "contentType").empty()) h.emplace_back("content-type", get(p, "contentType"));
    if (!get(p, "cacheControl").empty()) h.emplace_back("cache-control", get(p, "cacheControl"));
    return h;
}

// ── sign ────────────────────────────────────────────────────────────────────────────────────────────────────────
int sign_one(const plugin_input_frame_t* frame, Session* session) {
    if (!frame->payload || !has_identifier(frame->payload, frame->payload_length, "$APR") ||
        !verify_unaligned(frame->payload, frame->payload_length, verify_apr)) {
        plugin_set_error("invalid-task", "a task frame is not an $APR record");
        return 400;
    }
    const APR* apr = GetAPR(frame->payload);
    const Params p = params_of(apr);
    const std::string route = apr->ROUTE() ? apr->ROUTE()->str() : std::string();
    const std::string request_id = request_id_of(apr, p);
    if (route != "put" && route != "get" && route != "head" && route != "delete" && route != "list") {
        return push_result(refusal(request_id, route, 400, "unknown-route", "route is put, get, head, delete or list", p));
    }
    Target t;
    std::string message;
    const std::string bad = target_from(p, route != "list", &t, &message);
    if (!bad.empty()) return push_result(refusal(request_id, route, 400, bad, message, p));
    const Credential* credential = session->credential(t.store);
    if (!credential) {
        return push_result(refusal(request_id, route, 403, "no-credential",
                                   "no credential is held for store \"" + t.store + "\" (a stored credential and a secrets:storage_" + t.store + " read grant are needed)", p));
    }
    const std::string date = session->amz_date(p);
    if (date.empty()) return push_result(refusal(request_id, route, 503, "no-clock", "the host published no clock and the task fixed no date", p));

    const bool fresh_read = get(p, "freshRead") != "false";  // false: sign exactly the headers a vendor example shows
    Op op;
    op.context = make_context(request_id, route, p, {});
    op.timeout_ms = static_cast<uint32_t>(get_u64(p, "timeoutMs", kDefaultTimeoutMs));
    if (route == "head") {
        if (get(p, "headVia") == "head") {
            op.method = "HEAD";
        } else {
            // The metadata read is a one-byte ranged GET: the Go node's http connector reads a Content-Length body
            // from every response, so a HEAD answered 200 with a non-empty Content-Length fails there as a short read
            // ("unexpected EOF"). Content-Range carries the size. headVia=head asks for the real HEAD.
            op.method = "GET";
            op.headers.emplace_back("range", "bytes=0-0");
            op.max_bytes = 4 * kMiB;
        }
        if (fresh_read) op.headers.emplace_back("if-none-match", kNoValidator);
    } else if (route == "delete") {
        op.method = "DELETE";
    } else if (route == "get") {
        op.method = "GET";
        if (!get(p, "range").empty()) op.headers.emplace_back("range", get(p, "range"));
        if (fresh_read) op.headers.emplace_back("if-none-match", kNoValidator);
        op.max_bytes = get_u64(p, "maxBytes", 96 * kMiB);
    } else if (route == "list") {
        op.method = "GET";
        if (fresh_read) op.headers.emplace_back("if-none-match", kNoValidator);
        op.with_key = false;
        op.query.emplace_back("list-type", "2");
        for (const auto& [param, q] : std::vector<std::pair<const char*, const char*>>{
                 {"prefix", "prefix"}, {"delimiter", "delimiter"}, {"maxKeys", "max-keys"},
                 {"continuationToken", "continuation-token"}, {"startAfter", "start-after"}}) {
            if (!get(p, param).empty()) op.query.emplace_back(q, get(p, param));
        }
        op.max_bytes = 32 * kMiB;
    } else {  // put
        const uint8_t* body = apr->BODY() ? apr->BODY()->data() : nullptr;
        const size_t length = apr->BODY() ? apr->BODY()->size() : 0;
        const uint64_t threshold = get_u64(p, "multipartThreshold", kDefaultThreshold);
        op.headers = put_headers(p);
        if (length > threshold) {
            const uint64_t part_size = get_u64(p, "partSize", kDefaultPartSize);
            if (part_size < kMinPartSize || (length + part_size - 1) / part_size > kMaxParts) {
                return push_result(refusal(request_id, route, 400, "bad-part-size", "partSize is at least 5 MiB and the object at most 10000 parts", p));
            }
            op.method = "POST";
            op.query.emplace_back("uploads", "");
            op.context = make_context(request_id, route, p, {{"_phase", "create"}, {"_size", std::to_string(length)}});
            op.max_bytes = 4 * kMiB;
            // The task itself, verbatim, for the split stage: the body does not ride the create exchange.
            if (plugin_push_output_ex("held", "APR.fbs", APRIdentifier(), PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, "APR", 0, 8,
                                      frame->payload, frame->payload_length) < 0) {
                return 500;
            }
        } else {
            op.method = "PUT";
            op.body = body;
            op.body_len = length;
            op.unsigned_payload = unsigned_payload(p, t, length);
            op.max_bytes = 4 * kMiB;
        }
    }
    return push_signed(t, *credential, date, op);
}

int run_sign() {
    const auto tasks = frames_on("task");
    if (tasks.empty()) return 0;
    Session session;
    for (const auto* frame : tasks) {
        const int rc = sign_one(frame, &session);
        if (rc != 0) return rc;
    }
    return 0;
}

// ── split: the create response + the original put -> the parts ──────────────────────────────────────────────────
// A response frame viewed in place.
const R::HttpResponse* response_of(const plugin_input_frame_t* frame) {
    if (!frame->payload || !has_identifier(frame->payload, frame->payload_length, "HRSP") ||
        !verify_unaligned(frame->payload, frame->payload_length, verify_hrsp)) {
        return nullptr;
    }
    return R::GetHttpResponse(frame->payload);
}
std::string_view body_text(const R::HttpResponse* r) {
    return r->BODY() ? std::string_view(reinterpret_cast<const char*>(r->BODY()->data()), r->BODY()->size()) : std::string_view();
}
std::string header_of(const R::HttpResponse* r, const char* name) {
    if (!r->HEADERS()) return std::string();
    for (const auto* h : *r->HEADERS())
        if (h && h->NAME() && lower(h->NAME()->str()) == name) return h->VALUE() ? h->VALUE()->str() : std::string();
    return std::string();
}

// The store's error, from an XML <Error> body, else from the status.
void store_error(const R::HttpResponse* r, Outcome* o) {
    o->status = r->STATUS() > 0 ? static_cast<uint16_t>(r->STATUS()) : 502;
    const std::string_view body = body_text(r);
    const std::string code = xml_first(body, "Code");
    const std::string message = xml_first(body, "Message");
    if (r->STATUS() <= 0) {
        o->error_code = "exchange-failed";
        o->error_message = r->ERROR() ? r->ERROR()->str() : std::string("the http exchange failed");
    } else {
        o->error_code = code.empty() ? "http-" + std::to_string(r->STATUS()) : code;
        o->error_message = message;
    }
}

int abort_upload(const Target& t, const Credential& c, const std::string& date, const std::string& request_id, const Params& p, const std::string& upload_id) {
    Op op;
    op.method = "DELETE";
    op.query.emplace_back("uploadId", upload_id);
    op.context = make_context(request_id, "put", p, {{"_phase", "abort"}, {"_uploadId", upload_id}});
    op.max_bytes = kMiB;
    return push_signed(t, c, date, op);
}

int run_split() {
    const auto created = frames_on("created");
    const auto objects = frames_on("object");
    if (created.empty()) return 0;  // every put was small: nothing to split
    Session session;
    for (const auto* frame : created) {
        const R::HttpResponse* response = response_of(frame);
        if (!response) {
            plugin_set_error("invalid-response-frame", "a created frame is not an HttpResponse (HRSP)");
            return 400;
        }
        const Context ctx = read_context(response->CONTEXT());
        if (!ctx.ok || get(ctx.p, "_phase") != "create") continue;  // a small put's PUT answer is not ours
        Target t;
        std::string message;
        if (!target_from(ctx.p, true, &t, &message).empty()) continue;
        Outcome fail = refusal(ctx.request_id, "put", 502, "", "", ctx.p);
        if (response->STATUS() < 200 || response->STATUS() >= 300) {
            store_error(response, &fail);
            fail.error_message = "CreateMultipartUpload refused: " + fail.error_message;
            if (push_result(fail) != 0) return 500;
            continue;
        }
        const std::string upload_id = xml_first(body_text(response), "UploadId");
        const Credential* credential = session.credential(t.store);
        if (upload_id.empty() || !credential) {
            fail.error_code = upload_id.empty() ? "no-upload-id" : "no-credential";
            fail.error_message = upload_id.empty() ? "CreateMultipartUpload answered without an UploadId" : "the credential is gone";
            if (push_result(fail) != 0) return 500;
            continue;
        }
        const std::string date = session.amz_date(ctx.p);
        // the original put, by identity
        const APR* original = nullptr;
        for (const auto* o : objects) {
            if (!o->payload || !has_identifier(o->payload, o->payload_length, "$APR") || !verify_unaligned(o->payload, o->payload_length, verify_apr)) continue;
            const APR* candidate = GetAPR(o->payload);
            const Params cp = params_of(candidate);
            if (identity(request_id_of(candidate, cp), cp) == identity(ctx.request_id, ctx.p)) { original = candidate; break; }
        }
        if (!original || !original->BODY()) {
            fail.error_code = "orphaned-multipart";
            fail.error_message = "the create answered but no matching put task reached the split node; the upload was aborted";
            if (abort_upload(t, *credential, date, ctx.request_id, ctx.p, upload_id) != 0) return 500;
            if (push_result(fail) != 0) return 500;
            continue;
        }
        const uint8_t* body = original->BODY()->data();
        const uint64_t length = original->BODY()->size();
        const uint64_t part_size = get_u64(ctx.p, "partSize", kDefaultPartSize);
        const uint64_t parts = (length + part_size - 1) / part_size;
        for (uint64_t n = 1; n <= parts; ++n) {
            const uint64_t offset = (n - 1) * part_size;
            Op op;
            op.method = "PUT";
            op.query.emplace_back("partNumber", std::to_string(n));
            op.query.emplace_back("uploadId", upload_id);
            op.body = body + offset;
            op.body_len = static_cast<size_t>(std::min<uint64_t>(part_size, length - offset));
            op.unsigned_payload = unsigned_payload(ctx.p, t, op.body_len);
            op.max_bytes = 4 * kMiB;
            op.context = make_context(ctx.request_id, "put", ctx.p,
                                      {{"_phase", "part"}, {"_uploadId", upload_id}, {"_part", std::to_string(n)},
                                       {"_parts", std::to_string(parts)}, {"_size", std::to_string(length)}});
            if (push_signed(t, *credential, date, op) != 0) return 500;
        }
    }
    return 0;
}

// ── assemble: the part responses -> complete (or abort) ─────────────────────────────────────────────────────────
struct PartRecord {
    uint64_t number = 0;
    int32_t status = 0;
    std::string etag;
    std::string error_code, error_message;
};
struct Upload {
    std::string request_id, upload_id;
    Params p;
    uint64_t expected = 0, size = 0;
    std::vector<PartRecord> parts;
};

int run_assemble() {
    const auto frames = frames_on("parts");
    if (frames.empty()) return 0;
    std::map<std::string, Upload> uploads;
    std::vector<std::string> order;
    for (const auto* frame : frames) {
        const R::HttpResponse* response = response_of(frame);
        if (!response) {
            plugin_set_error("invalid-response-frame", "a parts frame is not an HttpResponse (HRSP)");
            return 400;
        }
        const Context ctx = read_context(response->CONTEXT());
        if (!ctx.ok || get(ctx.p, "_phase") != "part") continue;
        const std::string id = identity(ctx.request_id, ctx.p) + "\x1f" + get(ctx.p, "_uploadId");
        auto [it, fresh] = uploads.try_emplace(id);
        Upload& u = it->second;
        if (fresh) {
            order.push_back(id);
            u.request_id = ctx.request_id;
            u.upload_id = get(ctx.p, "_uploadId");
            u.p = ctx.p;
            u.expected = get_u64(ctx.p, "_parts", 0);
            u.size = get_u64(ctx.p, "_size", 0);
        }
        PartRecord rec;
        rec.number = get_u64(ctx.p, "_part", 0);
        rec.status = response->STATUS();
        rec.etag = header_of(response, "etag");
        if (response->STATUS() < 200 || response->STATUS() >= 300) {
            Outcome probe;
            store_error(response, &probe);
            rec.error_code = probe.error_code;
            rec.error_message = probe.error_message;
        } else if (rec.etag.empty()) {
            rec.error_code = "no-etag";
            rec.error_message = "the store accepted the part without an ETag";
        }
        u.parts.push_back(std::move(rec));
    }
    Session session;
    for (const std::string& id : order) {
        Upload& u = uploads[id];
        std::sort(u.parts.begin(), u.parts.end(), [](const PartRecord& a, const PartRecord& b) { return a.number < b.number; });
        Target t;
        std::string message;
        if (!target_from(u.p, true, &t, &message).empty()) continue;
        const Credential* credential = session.credential(t.store);
        const std::string date = session.amz_date(u.p);
        std::string failure_code, failure_message;
        for (const PartRecord& rec : u.parts) {
            if (!rec.error_code.empty()) {
                failure_code = "multipart-part-failed";
                failure_message = "part " + std::to_string(rec.number) + ": " + rec.error_code + (rec.error_message.empty() ? "" : " - " + rec.error_message);
                break;
            }
        }
        if (failure_code.empty() && u.parts.size() != u.expected) {
            failure_code = "multipart-incomplete";
            failure_message = "expected " + std::to_string(u.expected) + " part responses, got " + std::to_string(u.parts.size());
        }
        if (failure_code.empty()) {
            for (size_t i = 0; i < u.parts.size(); ++i)
                if (u.parts[i].number != i + 1) { failure_code = "multipart-incomplete"; failure_message = "part numbers are not 1..N"; break; }
        }
        if (!credential || date.empty()) {
            failure_code = credential ? "no-clock" : "no-credential";
            failure_message = "cannot sign the " + std::string(failure_code == "no-clock" ? "completion" : "completion; the credential is gone");
        }
        if (!failure_code.empty()) {
            if (credential && !date.empty() && abort_upload(t, *credential, date, u.request_id, u.p, u.upload_id) != 0) return 500;
            Outcome o = refusal(u.request_id, "put", 502, failure_code, failure_message, u.p);
            o.echo["uploadId"] = u.upload_id;
            if (push_result(o) != 0) return 500;
            continue;
        }
        std::string xml = "<CompleteMultipartUpload>";
        for (const PartRecord& rec : u.parts) xml += "<Part><PartNumber>" + std::to_string(rec.number) + "</PartNumber><ETag>" + xml_escape(rec.etag) + "</ETag></Part>";
        xml += "</CompleteMultipartUpload>";
        Op op;
        op.method = "POST";
        op.query.emplace_back("uploadId", u.upload_id);
        op.headers.emplace_back("content-type", "application/xml");
        op.body = reinterpret_cast<const uint8_t*>(xml.data());
        op.body_len = xml.size();
        op.max_bytes = 4 * kMiB;
        op.context = make_context(u.request_id, "put", u.p,
                                  {{"_phase", "complete"}, {"_uploadId", u.upload_id}, {"_parts", std::to_string(u.expected)}, {"_size", std::to_string(u.size)}});
        if (push_signed(t, *credential, date, op) != 0) return 500;
    }
    return 0;
}

// ── finish: the response -> the result ──────────────────────────────────────────────────────────────────────────
int push_listing(const R::HttpResponse* response, const Context& ctx, Outcome* o) {
    const std::string_view xml = body_text(response);
    FILT listing;
    listing.PATH = get(ctx.p, "bucket") + "/" + get(ctx.p, "prefix");
    listing.NAME = get(ctx.p, "bucket");
    listing.KIND = filEntryKind_Directory;
    size_t at = 0;
    std::string block;
    size_t next = 0;
    while (xml_text(xml, "Contents", at, &block, &next)) {
        // block was unescaped as a whole; re-find the pieces from the raw span instead
        const size_t open = xml.find("<Contents>", at);
        const std::string_view raw = xml.substr(open, next - open);
        auto entry = std::make_unique<FILEntryT>();
        entry->NAME = xml_first(raw, "Key");
        entry->KIND = filEntryKind_File;
        entry->SIZE = std::strtoull(xml_first(raw, "Size").c_str(), nullptr, 10);
        entry->MODIFIED_AT_MS = parse_iso_ms(xml_first(raw, "LastModified"));
        listing.ENTRIES.push_back(std::move(entry));
        at = next;
    }
    at = 0;
    while (xml_text(xml, "CommonPrefixes", at, &block, &next)) {
        const size_t open = xml.find("<CommonPrefixes>", at);
        const std::string_view raw = xml.substr(open, next - open);
        auto entry = std::make_unique<FILEntryT>();
        entry->NAME = xml_first(raw, "Prefix");
        entry->KIND = filEntryKind_Directory;
        listing.ENTRIES.push_back(std::move(entry));
        at = next;
    }
    o->echo["keyCount"] = std::to_string(listing.ENTRIES.size());
    o->echo["isTruncated"] = xml_first(xml, "IsTruncated") == "true" ? "true" : "false";
    const std::string token = xml_first(xml, "NextContinuationToken");
    if (!token.empty()) o->echo["nextContinuationToken"] = token;
    flatbuffers::FlatBufferBuilder b(1024);
    FinishFILBuffer(b, FIL::Pack(b, &listing));
    // the result carries the listing too, so an HTTP client (one $APR answer) can read it
    o->body.assign(b.GetBufferPointer(), b.GetBufferPointer() + b.GetSize());
    return plugin_push_output_ex("listing", "FIL.fbs", FILIdentifier(), PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, "FIL", 0, 8,
                                 b.GetBufferPointer(), static_cast<uint32_t>(b.GetSize())) < 0 ? 500 : 0;
}

int run_finish() {
    const auto frames = frames_on("responses");
    if (frames.empty()) return 0;
    for (const auto* frame : frames) {
        const R::HttpResponse* response = response_of(frame);
        if (!response) {
            plugin_set_error("invalid-response-frame", "a responses frame is not an HttpResponse (HRSP)");
            return 400;
        }
        const Context ctx = read_context(response->CONTEXT());
        if (!ctx.ok) {
            plugin_set_error("lost-context", "a response carried no $APR run contract in CONTEXT");
            return 400;
        }
        const std::string phase = get(ctx.p, "_phase");
        if (phase == "create" || phase == "part" || phase == "abort") continue;  // split / assemble own these stages
        Outcome o;
        o.request_id = ctx.request_id;
        o.route = ctx.route;
        for (const char* name : {"store", "bucket", "key"}) if (!get(ctx.p, name).empty()) o.echo[name] = get(ctx.p, name);
        std::string_view body = body_text(response);
        const bool success = response->STATUS() >= 200 && response->STATUS() < 300 && !(phase == "complete" && body.find("<Error>") != std::string_view::npos);
        if (response->STATUS() == 416 && ctx.route == "head" && get(ctx.p, "headVia") != "head") {
            // a range over an empty object is unsatisfiable: the object exists and is zero bytes
            o.status = 200;
            o.headers.emplace_back("content-length", "0");
            if (push_result(o) != 0) return 500;
            continue;
        }
        if (response->STATUS() == 404 && (ctx.route == "head" || ctx.route == "get")) {
            // a missing object is an answer, not a transport failure
            o.status = 404;
            o.error_code = ctx.route == "head" ? "NotFound" : xml_first(body, "Code");
            if (o.error_code.empty()) o.error_code = "NoSuchKey";
            o.error_message = xml_first(body, "Message");
            if (push_result(o) != 0) return 500;
            continue;
        }
        if (!success) {
            store_error(response, &o);
            if (phase == "complete" && response->STATUS() >= 200 && response->STATUS() < 300) {
                o.status = 502;
                o.error_code = xml_first(body, "Code");
                o.error_message = xml_first(body, "Message");
            }
            if (push_result(o) != 0) return 500;
            continue;
        }
        o.status = static_cast<uint16_t>(response->STATUS());
        for (const char* name : {"etag", "content-length", "content-type", "last-modified", "content-range", "accept-ranges", "cache-control"}) {
            const std::string v = header_of(response, name);
            if (!v.empty()) o.headers.emplace_back(name, v);
        }
        if (ctx.route == "head" && get(ctx.p, "headVia") != "head") {
            // the size of the object is the total of the Content-Range of the one-byte read
            o.status = 200;
            const std::string range = header_of(response, "content-range");
            const size_t slash = range.find('/');
            for (auto& [name, value] : o.headers) {
                if (name == "content-length" && slash != std::string::npos) value = range.substr(slash + 1);
            }
            o.headers.erase(std::remove_if(o.headers.begin(), o.headers.end(), [](const auto& h) { return h.first == "content-range"; }), o.headers.end());
        }
        if (ctx.route == "get" && response->BODY()) o.body.assign(response->BODY()->begin(), response->BODY()->end());
        if (ctx.route == "list") {
            if (push_listing(response, ctx, &o) != 0) return 500;
        }
        if (phase == "complete") {
            o.echo["uploadId"] = get(ctx.p, "_uploadId");
            o.echo["parts"] = get(ctx.p, "_parts");
            o.echo["size"] = get(ctx.p, "_size");
            const std::string etag = xml_first(body, "ETag");
            if (!etag.empty()) o.headers.emplace_back("etag", etag);
        }
        if (push_result(o) != 0) return 500;
    }
    return 0;
}


// ── serve: the HTTP edge ($HTQ) -> a task ─────────────────────────────────────────────────────────────────────────
std::string url_decode(const std::string& in, bool plus_is_space) {
    std::string out;
    for (size_t i = 0; i < in.size(); ++i) {
        if (in[i] == '%' && i + 2 < in.size() + 0 && std::isxdigit(static_cast<unsigned char>(in[i + 1])) &&
            std::isxdigit(static_cast<unsigned char>(in[i + 2]))) {
            out += static_cast<char>(std::strtol(in.substr(i + 1, 2).c_str(), nullptr, 16));
            i += 2;
        } else if (plus_is_space && in[i] == '+') {
            out += ' ';
        } else {
            out += in[i];
        }
    }
    return out;
}

int push_decision(uint16_t status, const std::string& code, const std::string& message) {
    APRT refusal;
    refusal.ROUTE = "serve";
    refusal.STATUS = status;
    refusal.ERROR_CODE = code;
    refusal.ERROR_MESSAGE = message;
    flatbuffers::FlatBufferBuilder b(512);
    FinishAPRBuffer(b, APR::Pack(b, &refusal));
    return plugin_push_output_ex("decision", "APR.fbs", APRIdentifier(), PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, "APR", 0, 8,
                                 b.GetBufferPointer(), static_cast<uint32_t>(b.GetSize())) < 0 ? 500 : 0;
}

int run_serve() {
    const auto requests = frames_on("request");
    if (requests.empty()) return 0;
    if (requests.size() > 1) {
        plugin_set_error("batched-input-frames", "serve answers ONE HTTP exchange; the surplus frame is refused rather than silently discarded.");
        return 500;
    }
    const plugin_input_frame_t* frame = requests[0];
    if (!frame->payload || frame->payload_length < 8 || !sdn::http::HttpRequestBufferHasIdentifier(frame->payload) ||
        !verify_unaligned(frame->payload, frame->payload_length, [](flatbuffers::Verifier& v) { return sdn::http::VerifyHttpRequestBuffer(v); })) {
        return push_decision(400, "invalid-request", "the request is not an $HTQ envelope");
    }
    const sdn::http::HttpRequest* r = sdn::http::GetHttpRequest(frame->payload);
    std::string method = r->METHOD() ? r->METHOD()->str() : std::string();
    for (char& c : method) c = static_cast<char>(std::toupper(static_cast<unsigned char>(c)));
    const std::string path = r->PATH() ? r->PATH()->str() : std::string();
    const std::string query = r->QUERY() ? r->QUERY()->str() : std::string();
    constexpr const char* kSegment = "/objects/";
    const size_t at = path.rfind(kSegment);
    if (at == std::string::npos) return push_decision(404, "no-route", "the object route is /objects/<store>/<bucket>/<key>");
    // <store>/<bucket>[/<key>]; each segment is percent-decoded here (the host passes the escaped path)
    std::vector<std::string> segments;
    {
        const std::string rest = path.substr(at + std::strlen(kSegment));
        size_t from = 0;
        while (true) {
            const size_t slash = rest.find('/', from);
            segments.push_back(url_decode(rest.substr(from, slash == std::string::npos ? std::string::npos : slash - from), false));
            if (slash == std::string::npos) break;
            from = slash + 1;
        }
    }
    if (segments.size() < 2 || segments[0].empty() || segments[1].empty()) {
        return push_decision(404, "no-bucket", "the object route is /objects/<store>/<bucket>/<key>");
    }
    std::string key;
    for (size_t i = 2; i < segments.size(); ++i) key += (i > 2 ? "/" : "") + segments[i];

    Params p;
    p["store"] = segments[0];
    p["bucket"] = segments[1];
    if (!key.empty()) p["key"] = key;
    {
        size_t from = 0;
        while (from <= query.size()) {
            size_t amp = query.find('&', from);
            if (amp == std::string::npos) amp = query.size();
            const std::string pair = query.substr(from, amp - from);
            const size_t eq = pair.find('=');
            if (!pair.empty()) {
                const std::string name = url_decode(pair.substr(0, eq), true);
                const std::string value = eq == std::string::npos ? std::string() : url_decode(pair.substr(eq + 1), true);
                // the task names its own target and options; identity fields come from the path alone
                if (name != "store" && name != "bucket" && name != "key" && !name.empty() && name[0] != '_') p[name] = value;
            }
            from = amp + 1;
        }
    }
    std::string request_id;
    if (const auto* headers = r->HEADERS()) {
        for (const auto* h : *headers) {
            if (!h || !h->NAME()) continue;
            const std::string name = lower(h->NAME()->str());
            const std::string value = h->VALUE() ? h->VALUE()->str() : std::string();
            if (name == "range" && p.find("range") == p.end()) p["range"] = value;
            else if (name == "content-type" && p.find("contentType") == p.end()) p["contentType"] = value;
            else if (name == "x-request-id") request_id = value;
        }
    }
    std::string route;
    if (method == "PUT") route = "put";
    else if (method == "DELETE") route = "delete";
    else if (method == "HEAD") route = "head";
    else if (method == "GET") route = key.empty() ? "list" : (p.count("head") && p["head"] == "1") ? "head" : "get";  // ?head=1: the metadata as a record (an HTTP HEAD carries no body)
    else return push_decision(405, "method-not-allowed", "the object route takes PUT, GET, HEAD and DELETE");
    if (route != "list" && key.empty()) return push_decision(404, "no-key", "this route addresses one object: /objects/<store>/<bucket>/<key>");
    if (request_id.empty()) request_id = method + " " + segments[0] + "/" + segments[1] + "/" + key;
    // Built in place: the body of a put can be a hundred MiB, and an unpacked native task would hold it twice more.
    const size_t body_len = (route == "put" && r->BODY()) ? r->BODY()->size() : 0;
    flatbuffers::FlatBufferBuilder b(4096 + body_len);
    const auto id_offset = b.CreateString(request_id);
    const auto path_offset = b.CreateString(path);
    const auto route_offset = b.CreateString(route);
    std::vector<flatbuffers::Offset<APRParameter>> parameters;
    for (const auto& [k, v] : p) {
        const auto name_offset = b.CreateString(k);
        const auto value_offset = b.CreateString(v);
        parameters.push_back(CreateAPRParameter(b, name_offset, value_offset));
    }
    const auto parameters_offset = b.CreateVector(parameters);
    flatbuffers::Offset<flatbuffers::Vector<uint8_t>> body_offset;
    if (body_len) body_offset = b.CreateVector(r->BODY()->data(), body_len);
    APRBuilder task(b);
    task.add_REQUEST_ID(id_offset);
    task.add_PATH(path_offset);
    task.add_ROUTE(route_offset);
    task.add_PARAMETERS(parameters_offset);
    if (body_len) task.add_BODY(body_offset);
    FinishAPRBuffer(b, task.Finish());
    return plugin_push_output_ex("task", "APR.fbs", APRIdentifier(), PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, "APR", 0, 8,
                                 b.GetBufferPointer(), static_cast<uint32_t>(b.GetSize())) < 0 ? 500 : 0;
}

}  // namespace

extern "C" {

int serve(void) { return run_serve(); }
int sign(void) { return run_sign(); }
int split(void) { return run_split(); }
int assemble(void) { return run_assemble(); }
int finish(void) { return run_finish(); }

}  // extern "C"
