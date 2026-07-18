/*
 * provider_source.hpp — generic data-source provider scaffold (A2.2b template).
 *
 * This header factors the fetch / hash / store / sign-PNM / publish machinery
 * that every SDN operator-ephemeris data-source adapter needs, so the
 * SpaceX Starlink adapter (WS5) and the A2.2c Tier-1 adapters (OneWeb LTEF,
 * ISS OEM, Intelsat, GPS/GLONASS, CPF) share one proven skeleton. Only the
 * per-provider bits stay in the adapter's .cpp:
 *   1. the discovery URL + how to turn a listing into a per-object fetch plan,
 *   2. how to parse one upstream artifact into a canonical SDS record,
 *   3. the record schema + provenance labels.
 *
 * PROMOTED (A2.2c, 2026-07-13): this header now lives at
 * space-data-network-modules/common/provider_source.hpp (alongside
 * common/sdm_hostcall_wire.hpp) and is shared by every operator-ephemeris
 * data-source adapter — spacex-starlink-source (WS5), oneweb-source, and
 * iss-source (A2.2c). Each adapter's build.mjs already puts common/ on its
 * -I path (SDN_COMMON_DIR), so adapters include it by bare name:
 *   #include "provider_source.hpp"
 * (the same convention as sdm_hostcall_wire.hpp). It was extracted verbatim
 * from spacex-starlink-source/src/ — no behavior change on promotion.
 *
 * Transport: the http / storage.write / pubsub.publish helpers use the same
 * hand-framed hostcall envelope the module has always used against the Go node
 * bridge (decodeHostcallEnvelope) — deliberately unchanged to avoid a
 * transport regression. Signing uses the SDK's sdm_keyslot::keyslot_sign
 * crypto oracle (keyslot.sign): the slot's private key never enters guest
 * memory, only the signature does.
 */
#ifndef SDN_PROVIDER_SOURCE_HPP
#define SDN_PROVIDER_SOURCE_HPP

#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string>
#include <vector>

// sdm_hostcall_wire.hpp must precede keyslotClient.hpp (the SDK header asserts
// SDM_HOSTCALL_WIRE_HPP is already defined). Both are resolved via the -I flags
// build.mjs adds (SDN_COMMON_DIR + SDM_HOST_CPP_DIR).
#include "sdm_hostcall_wire.hpp"
#include "keyslotClient.hpp"

namespace provider_source {

// ─────────────────────────── base64 ───────────────────────────

inline std::string base64_encode(const uint8_t* data, size_t len) {
    static const char* alpha =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::string out;
    size_t i = 0;
    for (; i + 3 <= len; i += 3) {
        uint32_t n = (static_cast<uint32_t>(data[i]) << 16) |
                     (static_cast<uint32_t>(data[i + 1]) << 8) | data[i + 2];
        out.push_back(alpha[(n >> 18) & 63]);
        out.push_back(alpha[(n >> 12) & 63]);
        out.push_back(alpha[(n >> 6) & 63]);
        out.push_back(alpha[n & 63]);
    }
    if (i < len) {
        uint32_t n = static_cast<uint32_t>(data[i]) << 16;
        if (i + 1 < len) n |= static_cast<uint32_t>(data[i + 1]) << 8;
        out.push_back(alpha[(n >> 18) & 63]);
        out.push_back(alpha[(n >> 12) & 63]);
        out.push_back(i + 1 < len ? alpha[(n >> 6) & 63] : '=');
        out.push_back('=');
    }
    return out;
}

inline std::vector<uint8_t> base64_decode(const std::string& in) {
    int8_t tbl[256];
    for (int i = 0; i < 256; i++) tbl[i] = -1;
    const char* alpha =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    for (int i = 0; i < 64; i++) tbl[static_cast<uint8_t>(alpha[i])] = static_cast<int8_t>(i);
    std::vector<uint8_t> out;
    int val = 0, bits = -8;
    for (unsigned char c : in) {
        if (c == '=' ) break;
        if (tbl[c] == -1) continue;  // skip whitespace/newlines
        val = (val << 6) | tbl[c];
        bits += 6;
        if (bits >= 0) {
            out.push_back(static_cast<uint8_t>((val >> bits) & 0xFF));
            bits -= 8;
        }
    }
    return out;
}

// ─────────────────────────── SHA-256 ───────────────────────────
// Self-contained SHA-256. Used both to bind raw upstream source bytes into
// signed provenance (DPM convention: SOURCE_SHA256 = "SHA-256 hash of raw
// source bytes") and — via cid_v1_raw_sha256 below — to compute the CIDv1 the
// host's storage layer assigns to each stored record. Kept in-guest so both are
// deterministic and require no extra host capability.
//
// sha256_raw fills a 32-byte digest; sha256_hex is the lowercase-hex form
// (byte-for-byte identical to the pre-refactor helper — sha256_hex now delegates
// to sha256_raw).

inline void sha256_raw(const uint8_t* data, size_t len, uint8_t out[32]) {
    static const uint32_t K[64] = {
        0x428a2f98u,0x71374491u,0xb5c0fbcfu,0xe9b5dba5u,0x3956c25bu,0x59f111f1u,0x923f82a4u,0xab1c5ed5u,
        0xd807aa98u,0x12835b01u,0x243185beu,0x550c7dc3u,0x72be5d74u,0x80deb1feu,0x9bdc06a7u,0xc19bf174u,
        0xe49b69c1u,0xefbe4786u,0x0fc19dc6u,0x240ca1ccu,0x2de92c6fu,0x4a7484aau,0x5cb0a9dcu,0x76f988dau,
        0x983e5152u,0xa831c66du,0xb00327c8u,0xbf597fc7u,0xc6e00bf3u,0xd5a79147u,0x06ca6351u,0x14292967u,
        0x27b70a85u,0x2e1b2138u,0x4d2c6dfcu,0x53380d13u,0x650a7354u,0x766a0abbu,0x81c2c92eu,0x92722c85u,
        0xa2bfe8a1u,0xa81a664bu,0xc24b8b70u,0xc76c51a3u,0xd192e819u,0xd6990624u,0xf40e3585u,0x106aa070u,
        0x19a4c116u,0x1e376c08u,0x2748774cu,0x34b0bcb5u,0x391c0cb3u,0x4ed8aa4au,0x5b9cca4fu,0x682e6ff3u,
        0x748f82eeu,0x78a5636fu,0x84c87814u,0x8cc70208u,0x90befffau,0xa4506cebu,0xbef9a3f7u,0xc67178f2u};
    uint32_t h[8] = {0x6a09e667u,0xbb67ae85u,0x3c6ef372u,0xa54ff53au,
                     0x510e527fu,0x9b05688cu,0x1f83d9abu,0x5be0cd19u};
    std::vector<uint8_t> msg(data, data + len);
    uint64_t bitlen = static_cast<uint64_t>(len) * 8u;
    msg.push_back(0x80);
    while (msg.size() % 64 != 56) msg.push_back(0x00);
    for (int i = 7; i >= 0; --i) msg.push_back(static_cast<uint8_t>((bitlen >> (i * 8)) & 0xff));
    auto rotr = [](uint32_t x, uint32_t n) -> uint32_t { return (x >> n) | (x << (32 - n)); };
    for (size_t off = 0; off < msg.size(); off += 64) {
        uint32_t w[64];
        for (int i = 0; i < 16; ++i) {
            w[i] = (static_cast<uint32_t>(msg[off + i * 4]) << 24) |
                   (static_cast<uint32_t>(msg[off + i * 4 + 1]) << 16) |
                   (static_cast<uint32_t>(msg[off + i * 4 + 2]) << 8) |
                   (static_cast<uint32_t>(msg[off + i * 4 + 3]));
        }
        for (int i = 16; i < 64; ++i) {
            uint32_t s0 = rotr(w[i-15],7) ^ rotr(w[i-15],18) ^ (w[i-15] >> 3);
            uint32_t s1 = rotr(w[i-2],17) ^ rotr(w[i-2],19) ^ (w[i-2] >> 10);
            w[i] = w[i-16] + s0 + w[i-7] + s1;
        }
        uint32_t a=h[0],b=h[1],c=h[2],d=h[3],e=h[4],f=h[5],g=h[6],hh=h[7];
        for (int i = 0; i < 64; ++i) {
            uint32_t S1 = rotr(e,6) ^ rotr(e,11) ^ rotr(e,25);
            uint32_t ch = (e & f) ^ (~e & g);
            uint32_t t1 = hh + S1 + ch + K[i] + w[i];
            uint32_t S0 = rotr(a,2) ^ rotr(a,13) ^ rotr(a,22);
            uint32_t maj = (a & b) ^ (a & c) ^ (b & c);
            uint32_t t2 = S0 + maj;
            hh=g; g=f; f=e; e=d+t1; d=c; c=b; b=a; a=t1+t2;
        }
        h[0]+=a; h[1]+=b; h[2]+=c; h[3]+=d; h[4]+=e; h[5]+=f; h[6]+=g; h[7]+=hh;
    }
    for (int i = 0; i < 8; ++i) {
        out[i * 4]     = static_cast<uint8_t>((h[i] >> 24) & 0xff);
        out[i * 4 + 1] = static_cast<uint8_t>((h[i] >> 16) & 0xff);
        out[i * 4 + 2] = static_cast<uint8_t>((h[i] >> 8) & 0xff);
        out[i * 4 + 3] = static_cast<uint8_t>(h[i] & 0xff);
    }
}

inline std::string sha256_hex(const uint8_t* data, size_t len) {
    uint8_t d[32];
    sha256_raw(data, len, d);
    static const char* hex = "0123456789abcdef";
    std::string out;
    out.reserve(64);
    for (int i = 0; i < 32; ++i) {
        out.push_back(hex[(d[i] >> 4) & 0xf]);
        out.push_back(hex[d[i] & 0xf]);
    }
    return out;
}

// ─────────────────────────── CIDv1 (in-guest) ───────────────────────────
// storage.ingest_with_source is a BATCH op that returns only an inserted count,
// not a per-record content id — but a published PNM must still carry the
// resolvable CID of the stored record. So the adapter computes it in-guest and
// the value byte-matches what the host assigns
// (storage.computeCID → cidV1RawSHA256 → cid.NewCidV1(cid.Raw, mh.Sum(data,
// SHA2_256)).String()): a CIDv1, raw codec (0x55), sha2-256 multihash (0x12 0x20
// + 32 digest bytes), rendered in the CIDv1 default multibase — base32 lower,
// RFC-4648 alphabet, no padding, multibase prefix 'b'. Proven byte-identical to
// go-cid over known vectors in the adapter test suites.

// RFC-4648 base32 (lowercase, no padding). Alphabet: a-z 2-7.
inline std::string base32_lower_nopad(const uint8_t* data, size_t len) {
    static const char* alpha = "abcdefghijklmnopqrstuvwxyz234567";
    std::string out;
    out.reserve((len * 8 + 4) / 5);
    int buffer = 0;   // holds at most 12 meaningful low bits between flushes
    int bits = 0;
    for (size_t i = 0; i < len; ++i) {
        buffer = (buffer << 8) | data[i];
        bits += 8;
        while (bits >= 5) {
            bits -= 5;
            out.push_back(alpha[(buffer >> bits) & 0x1f]);
        }
        buffer &= (1 << bits) - 1;  // keep only the leftover low bits
    }
    if (bits > 0) out.push_back(alpha[(buffer << (5 - bits)) & 0x1f]);
    return out;
}

// CIDv1(raw, sha2-256) of `data`, multibase-'b' base32 — the exact string the
// host stores for these bytes. Frame: 0x01 (CIDv1) 0x55 (raw) 0x12 (sha2-256)
// 0x20 (32) + 32 digest bytes → base32-lower-nopad, prefixed 'b' (e.g. bafk…).
inline std::string cid_v1_raw_sha256(const uint8_t* data, size_t len) {
    uint8_t digest[32];
    sha256_raw(data, len, digest);
    uint8_t frame[36];
    frame[0] = 0x01;  // CIDv1 version
    frame[1] = 0x55;  // multicodec: raw
    frame[2] = 0x12;  // multihash: sha2-256
    frame[3] = 0x20;  // digest length: 32
    for (int i = 0; i < 32; ++i) frame[4 + i] = digest[i];
    return std::string("b") + base32_lower_nopad(frame, sizeof(frame));
}

// ─────────────────────────── JSON helpers ───────────────────────────

inline std::string json_escape(const std::string& s) {
    std::string out;
    for (char c : s) {
        if (c == '"' || c == '\\') { out.push_back('\\'); out.push_back(c); }
        else if (c == '\n') out += "\\n";
        else if (c == '\r') out += "\\r";
        else if (c == '\t') out += "\\t";
        else out.push_back(c);
    }
    return out;
}

// Minimal "key":"..." string-field extractor (handles simple escapes).
inline bool json_string_field(const std::string& json, const std::string& key, std::string* out) {
    std::string needle = "\"" + key + "\"";
    size_t k = json.find(needle);
    if (k == std::string::npos) return false;
    size_t colon = json.find(':', k + needle.size());
    if (colon == std::string::npos) return false;
    size_t i = colon + 1;
    while (i < json.size() && (json[i] == ' ' || json[i] == '\t' || json[i] == '\n')) i++;
    if (i >= json.size() || json[i] != '"') return false;
    i++;
    std::string value;
    while (i < json.size() && json[i] != '"') {
        if (json[i] == '\\' && i + 1 < json.size()) {
            char n = json[i + 1];
            if (n == 'n') value.push_back('\n');
            else if (n == 't') value.push_back('\t');
            else if (n == 'r') value.push_back('\r');
            else value.push_back(n);
            i += 2;
        } else {
            value.push_back(json[i]);
            i++;
        }
    }
    *out = value;
    return true;
}

inline long json_number_field(const std::string& json, const std::string& key, long fallback) {
    std::string needle = "\"" + key + "\"";
    size_t k = json.find(needle);
    if (k == std::string::npos) return fallback;
    size_t colon = json.find(':', k + needle.size());
    if (colon == std::string::npos) return fallback;
    return strtol(json.c_str() + colon + 1, nullptr, 10);
}

// Format a double with enough precision to round-trip operator ephemeris state
// vectors (positions to sub-mm); trims to %.15g which preserves km-level OD
// fidelity without std::to_string's lossy 6-decimal "%f".
inline std::string double_to_json(double v) {
    char buf[64];
    snprintf(buf, sizeof(buf), "%.15g", v);
    return std::string(buf);
}

// ─────────────────────────── hostcall transport ───────────────────────────
// Hand-framed request envelope [u32 metaLen][meta][u32 0] (segment_count 0) —
// the exact framing the Go node bridge decodes. Response is read without
// clear_response (the manual path the module has always used).

inline std::vector<uint8_t> hostcall(const std::string& op, const std::string& payload_json) {
    std::vector<uint8_t> req(4 + payload_json.size() + 4, 0);
    uint32_t meta_len = static_cast<uint32_t>(payload_json.size());
    req[0] = static_cast<uint8_t>(meta_len & 0xff);
    req[1] = static_cast<uint8_t>((meta_len >> 8) & 0xff);
    req[2] = static_cast<uint8_t>((meta_len >> 16) & 0xff);
    req[3] = static_cast<uint8_t>((meta_len >> 24) & 0xff);
    for (size_t i = 0; i < payload_json.size(); ++i) req[4 + i] = static_cast<uint8_t>(payload_json[i]);
    // Trailing 4 zero bytes = segment_count 0.
    sdm_host_call(op.data(), static_cast<int32_t>(op.size()),
                  reinterpret_cast<const char*>(req.data()), static_cast<int32_t>(req.size()));
    int32_t len = sdm_host_response_len();
    std::vector<uint8_t> buf(len > 0 ? static_cast<size_t>(len) : 0);
    if (len > 0) sdm_host_read_response(reinterpret_cast<char*>(buf.data()), len);
    return buf;
}

inline std::string envelope_meta_json(const std::vector<uint8_t>& env) {
    if (env.size() < 4) return std::string();
    uint32_t meta_len = static_cast<uint32_t>(env[0]) | (static_cast<uint32_t>(env[1]) << 8) |
                        (static_cast<uint32_t>(env[2]) << 16) | (static_cast<uint32_t>(env[3]) << 24);
    if (env.size() < 4 + meta_len) return std::string();
    return std::string(reinterpret_cast<const char*>(env.data() + 4), meta_len);
}

inline bool cap_ok(const std::vector<uint8_t>& env) {
    return envelope_meta_json(env).find("\"ok\":true") != std::string::npos;
}

// ─────────────────────────── capabilities ───────────────────────────

struct HttpResult {
    long status = 0;
    std::vector<uint8_t> body;
};

inline HttpResult http_get(const std::string& url) {
    HttpResult r;
    std::string payload = "{\"method\":\"GET\",\"url\":\"" + json_escape(url) + "\"}";
    std::vector<uint8_t> env = hostcall("http.request", payload);
    std::string meta = envelope_meta_json(env);
    r.status = json_number_field(meta, "status", 0);
    std::string encoding, body;
    json_string_field(meta, "body_encoding", &encoding);
    if (!json_string_field(meta, "body", &body)) return r;
    if (encoding == "base64") r.body = base64_decode(body);
    else r.body = std::vector<uint8_t>(body.begin(), body.end());
    return r;
}

// http_get_range: fetch only the first `max_bytes` of `url` via an HTTP Range
// request (Range: bytes=0-(max_bytes-1)). Servers that honor ranges reply 206
// with just that prefix; servers that don't reply 200 with the full body (still
// correct, just no bandwidth saving). Used to pull only the OD fit window (~2
// orbits) from a large operator ephemeris file instead of the whole multi-day
// file. The kubo http cap already forwards request Headers, so no host change.
inline HttpResult http_get_range(const std::string& url, long max_bytes) {
    HttpResult r;
    std::string payload = "{\"method\":\"GET\",\"url\":\"" + json_escape(url) +
                          "\",\"headers\":{\"Range\":\"bytes=0-" +
                          std::to_string(max_bytes > 0 ? max_bytes - 1 : 0) + "\"}}";
    std::vector<uint8_t> env = hostcall("http.request", payload);
    std::string meta = envelope_meta_json(env);
    r.status = json_number_field(meta, "status", 0);
    std::string encoding, body;
    json_string_field(meta, "body_encoding", &encoding);
    if (!json_string_field(meta, "body", &body)) return r;
    if (encoding == "base64") r.body = base64_decode(body);
    else r.body = std::vector<uint8_t>(body.begin(), body.end());
    return r;
}

// STORAGE_WRITE: store raw record bytes under a schema. Returns the content id
// (cid) the host assigns, or "" on failure.
inline std::string storage_write(const std::string& schema, const uint8_t* data, size_t len) {
    std::string payload = "{\"schema\":\"" + json_escape(schema) + "\",\"data\":\"" +
                          base64_encode(data, len) + "\"}";
    std::vector<uint8_t> env = hostcall("storage.write", payload);
    if (!cap_ok(env)) return std::string();
    std::string cid;
    json_string_field(envelope_meta_json(env), "cid", &cid);
    return cid;
}

// SourceTags — provenance attribution the host binds to each ingested record
// (storage.SourceTags on the Go side). The host requires provider_id,
// source_name and batch_id to be non-empty. `source_name` is the fit-pipeline
// grouping key (select_provider matches on SourceTags.SourceName), so it MUST be
// the provider registry token (== PNM topic suffix): spacex-starlink, iss,
// oneweb, gps, glonass, intelsat, cpf.
struct SourceTags {
    std::string provider_id;    // required; adapters reuse source_name (no in-guest node identity)
    std::string source_name;    // required; fit-pipeline grouping key (registry token)
    std::string source_url;     // per-record upstream URL (optional to host)
    std::string batch_id;       // required; source_sha256 (raw upstream bytes hash, CelesTrak convention)
    std::string content_key_id; // "public"
};

// STORAGE_INGEST_WITH_SOURCE: store one record with SourceTags provenance via the
// storage.ingest_with_source host op (requires the storage_ingest grant). Records
// travel as a size-prefixed stream [u32le len][bytes], base64 into "records".
//
// reconcile is pinned to "none": the host's indexed-duplicates reconcile
// partitions on (norad, entity, type, ops_status, epoch) and would DELETE
// distinct sibling objects that share NORAD=0 + epoch from multi-object
// providers (GLONASS/GPS). Logical dedup is A2.6's scope, not the adapter's.
//
// Returns the host-reported inserted count (0 when the record's CID already
// exists — still successfully stored), or -1 when the op failed / was ungranted.
inline long storage_ingest_with_source(const std::string& schema,
                                       const uint8_t* data, size_t len,
                                       const SourceTags& tags,
                                       long* inserted_out) {
    // Single-record size-prefixed stream: [u32le len][record bytes].
    std::vector<uint8_t> stream;
    stream.reserve(4 + len);
    uint32_t n = static_cast<uint32_t>(len);
    stream.push_back(static_cast<uint8_t>(n & 0xff));
    stream.push_back(static_cast<uint8_t>((n >> 8) & 0xff));
    stream.push_back(static_cast<uint8_t>((n >> 16) & 0xff));
    stream.push_back(static_cast<uint8_t>((n >> 24) & 0xff));
    stream.insert(stream.end(), data, data + len);
    std::string records_b64 = base64_encode(stream.data(), stream.size());

    std::string payload = "{";
    payload += "\"schema\":\"" + json_escape(schema) + "\",";
    payload += "\"provider_id\":\"" + json_escape(tags.provider_id) + "\",";
    payload += "\"source_name\":\"" + json_escape(tags.source_name) + "\",";
    payload += "\"source_url\":\"" + json_escape(tags.source_url) + "\",";
    payload += "\"batch_id\":\"" + json_escape(tags.batch_id) + "\",";
    payload += "\"content_key_id\":\"" + json_escape(tags.content_key_id) + "\",";
    payload += "\"reconcile\":\"none\",";
    payload += "\"records\":\"" + records_b64 + "\"}";

    std::vector<uint8_t> env = hostcall("storage.ingest_with_source", payload);
    if (!cap_ok(env)) {
        if (inserted_out) *inserted_out = 0;
        return -1;
    }
    long inserted = json_number_field(envelope_meta_json(env), "inserted", 0);
    if (inserted_out) *inserted_out = inserted;
    return inserted;
}

// PUBSUB publish (utf8) to a topic.
inline bool pubsub_publish(const std::string& topic, const std::string& data) {
    std::string payload = "{\"topic\":\"" + json_escape(topic) + "\",\"data\":\"" +
                          json_escape(data) + "\"}";
    return cap_ok(hostcall("pubsub.publish", payload));
}

// WALLET_SIGN via the keyslot.sign crypto oracle. The slot's private key never
// crosses into guest memory — only the signature does. Returns {} on failure.
inline std::vector<uint8_t> keyslot_sign(const std::string& slot_id, const uint8_t* data, size_t len) {
    std::vector<uint8_t> signature;
    if (!sdm_keyslot::keyslot_sign(slot_id, data, len, &signature)) return {};
    return signature;
}

// ─────────────────────────── manifest helpers ───────────────────────────

// Split a text listing into non-empty trimmed lines that contain `marker`
// (e.g. the "MEME_" filename prefix). One entry per line is the common shape
// for the provider listings A2.2c targets.
inline std::vector<std::string> listing_lines(const std::vector<uint8_t>& listing, const std::string& marker) {
    std::vector<std::string> lines;
    std::string s(listing.begin(), listing.end());
    size_t start = 0;
    while (start <= s.size()) {
        size_t nl = s.find('\n', start);
        std::string line = s.substr(start, (nl == std::string::npos ? s.size() : nl) - start);
        // trim CR/space
        size_t a = line.find_first_not_of(" \t\r");
        size_t b = line.find_last_not_of(" \t\r");
        if (a != std::string::npos) {
            std::string t = line.substr(a, b - a + 1);
            if (marker.empty() || t.find(marker) != std::string::npos) lines.push_back(t);
        }
        if (nl == std::string::npos) break;
        start = nl + 1;
    }
    return lines;
}

// ─────────────────────────── PNM + publish flow ───────────────────────────

struct ProviderConfig {
    std::string signing_slot;    // keyslot id for PNM signing (host-side key)
    std::string publish_topic;   // pubsub topic for signed PNM pointers
    std::string signature_type;  // e.g. "ed25519" (must match the slot's key)
    std::string source_name;     // provenance source id, e.g. "spacex-starlink"
    std::string data_source;     // CelesTrak-comparable token, e.g. "SpaceX-E"
    std::string record_schema;   // stored canonical record schema, e.g. "OEM"
};

// Publish Notification Message (PNM) — schema-exact keys per the SDS PNM table.
struct Pnm {
    std::string file_name;          // FILE_NAME  (source artifact name)
    std::string file_id;            // FILE_ID    (stable publication partition id)
    std::string cid;                // CID        (content id of the stored record)
    std::string multiformat_address;// MULTIFORMAT_ADDRESS (host resolves; may be "")
    std::string publish_timestamp;  // PUBLISH_TIMESTAMP (ISO 8601)
    std::string signature_b64;      // SIGNATURE  (base64, over CID)
    std::string signature_type;     // SIGNATURE_TYPE
};

inline std::string pnm_to_json(const Pnm& p) {
    std::string out = "{";
    out += "\"MULTIFORMAT_ADDRESS\":\"" + json_escape(p.multiformat_address) + "\",";
    out += "\"PUBLISH_TIMESTAMP\":\"" + json_escape(p.publish_timestamp) + "\",";
    out += "\"CID\":\"" + json_escape(p.cid) + "\",";
    out += "\"FILE_NAME\":\"" + json_escape(p.file_name) + "\",";
    out += "\"FILE_ID\":\"" + json_escape(p.file_id) + "\",";
    out += "\"SIGNATURE\":\"" + json_escape(p.signature_b64) + "\",";
    out += "\"SIGNATURE_TYPE\":\"" + json_escape(p.signature_type) + "\"";
    out += "}";
    return out;
}

struct PublishResult {
    bool stored = false;
    bool signed_ = false;
    bool published = false;
    std::string cid;
};

// The generic per-record flow every adapter reuses:
//   storage.write(record)  -> cid
//   keyslot.sign(cid)      -> signature   (host-side crypto oracle)
//   build PNM (schema-exact) + wrap with a provenance sidecar
//   pubsub.publish(topic, {"PNM":..,"provenance":..})
// `provenance_json` is a caller-built object of schema-exact provenance fields
// (SOURCE_NAME, SOURCE_URL, SOURCE_SHA256, DATA_SOURCE, RECORD_SCHEMA, ...).
inline PublishResult publish_record(
    const ProviderConfig& cfg,
    const uint8_t* record_bytes, size_t record_len,
    const std::string& file_name,
    const std::string& file_id,
    const std::string& publish_timestamp,
    const std::string& provenance_json) {
    PublishResult res;
    res.cid = storage_write(cfg.record_schema, record_bytes, record_len);
    res.stored = !res.cid.empty();

    // Sign the record's content id (CID) — the stable commitment consumers verify.
    std::vector<uint8_t> sig =
        keyslot_sign(cfg.signing_slot, reinterpret_cast<const uint8_t*>(res.cid.data()), res.cid.size());
    res.signed_ = !sig.empty();

    Pnm pnm;
    pnm.file_name = file_name;
    pnm.file_id = file_id;
    pnm.cid = res.cid;
    pnm.multiformat_address = res.cid.empty() ? std::string() : ("/ipfs/" + res.cid);
    pnm.publish_timestamp = publish_timestamp;
    pnm.signature_b64 = base64_encode(sig.data(), sig.size());
    pnm.signature_type = cfg.signature_type;

    std::string message = "{\"PNM\":" + pnm_to_json(pnm) + ",\"provenance\":" + provenance_json + "}";
    res.published = pubsub_publish(cfg.publish_topic, message);
    return res;
}

// publish_record_with_source — publish_record's SourceTags-carrying twin
// (A2.2c-3). Same signed-PNM + provenance-sidecar shape, but the record is
// stored via storage.ingest_with_source so it carries provenance attribution
// the fit-pipeline groups on. Because ingest is a batch op that returns only a
// count (no per-record CID), the CID is computed IN-GUEST — byte-identical to
// the CID the host assigns for the same record bytes (cid_v1_raw_sha256).
//
// Tag mapping (host requires provider_id/source_name/batch_id non-empty; there
// is deliberately NO parser_version tag — parser version stays in the provenance
// sidecar): provider_id = source_name (adapters have no separate node identity),
// source_name = the registry token (grouping key), source_url per record,
// batch_id = source_sha256 (raw upstream bytes hash), content_key_id = "public".
inline PublishResult publish_record_with_source(
    const ProviderConfig& cfg,
    const uint8_t* record_bytes, size_t record_len,
    const std::string& file_name,
    const std::string& file_id,
    const std::string& publish_timestamp,
    const std::string& provenance_json,
    const std::string& source_url,
    const std::string& batch_id) {
    PublishResult res;

    // CID computed in-guest — the ingest op returns only an inserted count, but
    // this value byte-matches the host's stored CID for the same bytes.
    res.cid = cid_v1_raw_sha256(record_bytes, record_len);

    SourceTags tags;
    tags.provider_id = cfg.source_name;
    tags.source_name = cfg.source_name;
    tags.source_url = source_url;
    tags.batch_id = batch_id;
    tags.content_key_id = "public";

    long inserted = 0;
    long ingest = storage_ingest_with_source(cfg.record_schema, record_bytes, record_len, tags, &inserted);
    res.stored = ingest >= 0;  // ingest hostcall ok ⇒ record is in the store (inserted may be 0 on re-ingest)

    // Sign the record's content id (CID) — the stable commitment consumers verify.
    std::vector<uint8_t> sig =
        keyslot_sign(cfg.signing_slot, reinterpret_cast<const uint8_t*>(res.cid.data()), res.cid.size());
    res.signed_ = !sig.empty();

    Pnm pnm;
    pnm.file_name = file_name;
    pnm.file_id = file_id;
    pnm.cid = res.cid;
    pnm.multiformat_address = res.cid.empty() ? std::string() : ("/ipfs/" + res.cid);
    pnm.publish_timestamp = publish_timestamp;
    pnm.signature_b64 = base64_encode(sig.data(), sig.size());
    pnm.signature_type = cfg.signature_type;

    std::string message = "{\"PNM\":" + pnm_to_json(pnm) + ",\"provenance\":" + provenance_json + "}";
    res.published = pubsub_publish(cfg.publish_topic, message);
    return res;
}

}  // namespace provider_source

#endif  // SDN_PROVIDER_SOURCE_HPP
