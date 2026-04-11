/**
 * SDN Plugin Delivery Module (C++ / Crypto++)
 *
 * Fetches a plugin artifact from IPFS, encrypts it for the recipient, publishes
 * the encrypted bundle over IPFS, and returns a canonical module-delivery
 * GrantResponse FlatBuffer.
 */

#include <stdint.h>
#include <stddef.h>
#include <string.h>
#include <stdlib.h>

#include <array>
#include <memory>
#include <string>
#include <vector>

#include <flatbuffers/flatbuffers.h>
#include "BundleDescriptor_generated.h"
#include "GrantResponse_generated.h"
#include "PluginInvokeRequest_generated.h"
#include "PluginInvokeResponse_generated.h"
#include "TypedArenaBuffer_generated.h"
#include "WrappedContentKey_generated.h"

#include <cryptopp/aes.h>
#include <cryptopp/gcm.h>
#include <cryptopp/hkdf.h>
#include <cryptopp/sha.h>
#include <cryptopp/xed25519.h>
#include <cryptopp/secblock.h>

#ifdef __wasi__
#include <wasi/api.h>
#endif

static bool host_random_fill(uint8_t* output, size_t size);

class WasiRNG : public CryptoPP::RandomNumberGenerator {
public:
    void GenerateBlock(CryptoPP::byte* output, size_t size) override {
#if defined(SDN_WASI_PLUGIN)
        if (host_random_fill(reinterpret_cast<uint8_t*>(output), size)) {
            return;
        }
#endif
#ifdef __wasi__
        __wasi_random_get(output, size);
#else
        for (size_t i = 0; i < size; i++) {
            output[i] = static_cast<CryptoPP::byte>(rand());
        }
#endif
    }
    void IncorporateEntropy(const CryptoPP::byte*, size_t) override {}
};

#if defined(SDN_WASI_PLUGIN)
extern "C" __attribute__((import_module("sdn_host"), import_name("call_json")))
int32_t sdn_host_call_json(const char* op_ptr, int32_t op_len,
                           const char* payload_ptr, int32_t payload_len);

extern "C" __attribute__((import_module("sdn_host"), import_name("response_len")))
int32_t sdn_host_response_len(void);

extern "C" __attribute__((import_module("sdn_host"), import_name("read_response")))
int32_t sdn_host_read_response(char* dst_ptr, int32_t dst_len);

extern "C" __attribute__((import_module("sdn_host"), import_name("clear_response")))
int32_t sdn_host_clear_response(void);
#endif

static const uint8_t SERVER_PRIVATE_KEY[32] = { SDN_BAKED_SERVER_PRIVATE_KEY };

static const char HKDF_WRAP_INFO[] = "orbpro-key-server-artifact-wrap-v1";
static const char WRAP_ALGORITHM[] = "ecies-x25519-hkdf-sha256-aes-256-gcm";
static const char DEFAULT_REQ_ID[] = "deliver_plugin";
static const char DEFAULT_MODULE_ID[] = "module";
static const char DEFAULT_RUNTIME[] = "wasm";
static const char DEFAULT_ABI[] = "module-sdk/async-host-v1";
static const char DEFAULT_ENTRYPOINT[] = "plugin_invoke_stream";
static const char DEFAULT_CONTENT_CODEC[] = "application/wasm+encrypted";
static const char DEFAULT_ENCRYPTION_CODEC[] = "x25519-hkdf-sha256-aes-256-gcm";
static const size_t KEY_BYTES = 32;
static const size_t GCM_IV_BYTES = 12;
static const size_t GCM_TAG_BYTES = 16;

static const char B64_CHARS[] =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

static std::string base64_encode(const uint8_t* data, size_t len) {
    std::string out;
    out.reserve(((len + 2) / 3) * 4);
    for (size_t i = 0; i < len; i += 3) {
        uint32_t n = static_cast<uint32_t>(data[i]) << 16;
        if (i + 1 < len) {
            n |= static_cast<uint32_t>(data[i + 1]) << 8;
        }
        if (i + 2 < len) {
            n |= static_cast<uint32_t>(data[i + 2]);
        }
        out += B64_CHARS[(n >> 18) & 0x3f];
        out += B64_CHARS[(n >> 12) & 0x3f];
        out += (i + 1 < len) ? B64_CHARS[(n >> 6) & 0x3f] : '=';
        out += (i + 2 < len) ? B64_CHARS[n & 0x3f] : '=';
    }
    return out;
}

static std::vector<uint8_t> base64_decode(const char* in, size_t in_len) {
    std::vector<uint8_t> out;
    out.reserve(in_len * 3 / 4);
    int val = 0;
    int bits = -8;
    for (size_t i = 0; i < in_len; i++) {
        int v = -1;
        const char c = in[i];
        if (c >= 'A' && c <= 'Z') v = c - 'A';
        else if (c >= 'a' && c <= 'z') v = c - 'a' + 26;
        else if (c >= '0' && c <= '9') v = c - '0' + 52;
        else if (c == '+' || c == '-') v = 62;
        else if (c == '/' || c == '_') v = 63;
        else continue;
        val = (val << 6) + v;
        bits += 6;
        if (bits >= 0) {
            out.push_back(static_cast<uint8_t>((val >> bits) & 0xff));
            bits -= 8;
        }
    }
    return out;
}

static std::string bytes_to_hex(const uint8_t* data, size_t len) {
    static const char HEX[] = "0123456789abcdef";
    std::string out;
    out.reserve(len * 2);
    for (size_t i = 0; i < len; i++) {
        out += HEX[(data[i] >> 4) & 0x0f];
        out += HEX[data[i] & 0x0f];
    }
    return out;
}

static std::string json_get_string(const char* json, size_t json_len, const char* key) {
    std::string needle = std::string("\"") + key + "\":\"";
    const char* begin = json;
    const char* end = json + json_len;
    while (begin < end) {
        const void* found = memmem(begin, static_cast<size_t>(end - begin), needle.data(), needle.size());
        if (!found) {
            return {};
        }
        const char* value_start = static_cast<const char*>(found) + needle.size();
        const char* value_end = value_start;
        while (value_end < end && *value_end != '"') {
            value_end++;
        }
        return std::string(value_start, value_end);
    }
    return {};
}

struct DeliveryMetadata {
    std::string req_id;
    std::string module_id;
    std::string module_version;
    std::string runtime;
    std::string abi;
    std::string entrypoint;
    std::string publication_cid;
    std::string content_codec;
    std::string encryption_codec;
};

static DeliveryMetadata parse_metadata(const uint8_t* data, size_t len, const std::string& source_cid) {
    DeliveryMetadata metadata;
    const char* json = reinterpret_cast<const char*>(data);
    metadata.req_id = json_get_string(json, len, "reqId");
    metadata.module_id = json_get_string(json, len, "moduleId");
    metadata.module_version = json_get_string(json, len, "moduleVersion");
    metadata.runtime = json_get_string(json, len, "runtime");
    metadata.abi = json_get_string(json, len, "abi");
    metadata.entrypoint = json_get_string(json, len, "entrypoint");
    metadata.publication_cid = json_get_string(json, len, "publicationCid");
    metadata.content_codec = json_get_string(json, len, "contentCodec");
    metadata.encryption_codec = json_get_string(json, len, "encryptionCodec");

    if (metadata.req_id.empty()) metadata.req_id = DEFAULT_REQ_ID;
    if (metadata.module_id.empty()) metadata.module_id = DEFAULT_MODULE_ID;
    if (metadata.runtime.empty()) metadata.runtime = DEFAULT_RUNTIME;
    if (metadata.abi.empty()) metadata.abi = DEFAULT_ABI;
    if (metadata.entrypoint.empty()) metadata.entrypoint = DEFAULT_ENTRYPOINT;
    if (metadata.publication_cid.empty()) metadata.publication_cid = source_cid;
    if (metadata.content_codec.empty()) metadata.content_codec = DEFAULT_CONTENT_CODEC;
    if (metadata.encryption_codec.empty()) metadata.encryption_codec = DEFAULT_ENCRYPTION_CODEC;
    return metadata;
}

class NullRNG : public CryptoPP::RandomNumberGenerator {
public:
    void GenerateBlock(CryptoPP::byte*, size_t) override {}
    void IncorporateEntropy(const CryptoPP::byte*, size_t) override {}
};

static void derive_server_public_key(uint8_t out_pub[32]) {
    NullRNG rng;
    CryptoPP::x25519 x25519_scheme;
    x25519_scheme.GeneratePublicKey(rng, SERVER_PRIVATE_KEY, out_pub);
}

static void sha256_bytes(const uint8_t* data, size_t len, uint8_t out[32]) {
    CryptoPP::SHA256 hash;
    hash.Update(data, len);
    hash.Final(out);
}

struct EncryptedBundle {
    bool ok = false;
    std::vector<uint8_t> encrypted_bundle;
    std::array<uint8_t, 32> content_hash{};
    std::array<uint8_t, 32> ephemeral_public_key{};
    std::vector<uint8_t> wrap_nonce;
    std::vector<uint8_t> wrapped_ciphertext;
    std::vector<uint8_t> wrapped_tag;
    std::string error;
};

static EncryptedBundle encrypt_bundle_for_recipient(
    const uint8_t* plaintext,
    size_t plaintext_len,
    const uint8_t* recipient_pub_key,
    size_t recipient_pub_len)
{
    EncryptedBundle out;
    if (recipient_pub_len != KEY_BYTES) {
        out.error = "recipient public key must be 32 bytes";
        return out;
    }

    WasiRNG rng;
    CryptoPP::x25519 x25519_scheme;
    CryptoPP::SecByteBlock ephemeral_private(KEY_BYTES);
    CryptoPP::SecByteBlock ephemeral_public(KEY_BYTES);
    x25519_scheme.GeneratePrivateKey(rng, ephemeral_private);
    x25519_scheme.GeneratePublicKey(rng, ephemeral_private, ephemeral_public);

    CryptoPP::SecByteBlock shared_secret(KEY_BYTES);
    if (!x25519_scheme.Agree(shared_secret, ephemeral_private, recipient_pub_key)) {
        out.error = "X25519 key agreement failed";
        return out;
    }

    CryptoPP::SecByteBlock wrap_key(KEY_BYTES);
    CryptoPP::HKDF<CryptoPP::SHA256> hkdf;
    hkdf.DeriveKey(
        wrap_key, KEY_BYTES,
        shared_secret, shared_secret.size(),
        nullptr, 0,
        reinterpret_cast<const uint8_t*>(HKDF_WRAP_INFO),
        sizeof(HKDF_WRAP_INFO) - 1
    );

    CryptoPP::SecByteBlock content_key(KEY_BYTES);
    rng.GenerateBlock(content_key, KEY_BYTES);

    std::array<uint8_t, GCM_IV_BYTES> wrap_iv{};
    rng.GenerateBlock(wrap_iv.data(), wrap_iv.size());

    std::vector<uint8_t> wrapped_key_and_tag(KEY_BYTES + GCM_TAG_BYTES);
    {
        CryptoPP::GCM<CryptoPP::AES>::Encryption enc;
        enc.SetKeyWithIV(wrap_key, KEY_BYTES, wrap_iv.data(), wrap_iv.size());
        CryptoPP::ArraySink sink(wrapped_key_and_tag.data(), wrapped_key_and_tag.size());
        CryptoPP::AuthenticatedEncryptionFilter filter(enc, &sink, false, GCM_TAG_BYTES);
        filter.Put(content_key, KEY_BYTES);
        filter.MessageEnd();
    }

    std::array<uint8_t, GCM_IV_BYTES> content_iv{};
    rng.GenerateBlock(content_iv.data(), content_iv.size());

    std::vector<uint8_t> ciphertext_and_tag(plaintext_len + GCM_TAG_BYTES);
    {
        CryptoPP::GCM<CryptoPP::AES>::Encryption enc;
        enc.SetKeyWithIV(content_key, KEY_BYTES, content_iv.data(), content_iv.size());
        CryptoPP::ArraySink sink(ciphertext_and_tag.data(), ciphertext_and_tag.size());
        CryptoPP::AuthenticatedEncryptionFilter filter(enc, &sink, false, GCM_TAG_BYTES);
        filter.Put(plaintext, plaintext_len);
        filter.MessageEnd();
    }

    out.encrypted_bundle.reserve(content_iv.size() + ciphertext_and_tag.size());
    out.encrypted_bundle.insert(out.encrypted_bundle.end(), content_iv.begin(), content_iv.end());
    out.encrypted_bundle.insert(
        out.encrypted_bundle.end(),
        ciphertext_and_tag.begin(),
        ciphertext_and_tag.end()
    );
    sha256_bytes(out.encrypted_bundle.data(), out.encrypted_bundle.size(), out.content_hash.data());
    std::copy(ephemeral_public.begin(), ephemeral_public.end(), out.ephemeral_public_key.begin());
    out.wrap_nonce.assign(wrap_iv.begin(), wrap_iv.end());
    out.wrapped_ciphertext.assign(
        wrapped_key_and_tag.begin(),
        wrapped_key_and_tag.begin() + KEY_BYTES
    );
    out.wrapped_tag.assign(
        wrapped_key_and_tag.begin() + KEY_BYTES,
        wrapped_key_and_tag.end()
    );
    out.ok = true;
    return out;
}

#if defined(SDN_WASI_PLUGIN)
static bool host_random_fill(uint8_t* output, size_t size) {
    const std::string payload =
        std::string("{\"length\":") + std::to_string(size) + "}";
    static const char OP[] = "random.bytes";
    if (sdn_host_call_json(OP, sizeof(OP) - 1, payload.c_str(), payload.size()) != 0) {
        return false;
    }

    const int32_t resp_len = sdn_host_response_len();
    if (resp_len <= 0) {
        sdn_host_clear_response();
        return false;
    }

    std::vector<char> buffer(static_cast<size_t>(resp_len));
    const int32_t read_len = sdn_host_read_response(buffer.data(), resp_len);
    sdn_host_clear_response();
    if (read_len != resp_len) {
        return false;
    }

    const std::string json(buffer.data(), buffer.size());
    if (json.find("\"ok\":true") == std::string::npos &&
        json.find("\"ok\": true") == std::string::npos) {
        return false;
    }

    const std::string base64 = json_get_string(json.data(), json.size(), "base64");
    if (base64.empty()) {
        return false;
    }
    const std::vector<uint8_t> bytes = base64_decode(base64.data(), base64.size());
    if (bytes.size() != size) {
        return false;
    }
    memcpy(output, bytes.data(), size);
    return true;
}

static bool read_hostcall_response(std::string& out_json) {
    const int32_t resp_len = sdn_host_response_len();
    if (resp_len <= 0) {
        return false;
    }
    std::vector<char> buffer(static_cast<size_t>(resp_len));
    const int32_t read_len = sdn_host_read_response(buffer.data(), resp_len);
    sdn_host_clear_response();
    if (read_len != resp_len) {
        return false;
    }
    out_json.assign(buffer.data(), buffer.size());
    return true;
}

static bool fetch_ipfs_bytes(const char* cid, size_t cid_len, std::vector<uint8_t>& out_bytes) {
    std::string payload = "{\"cid\":\"";
    payload.append(cid, cid_len);
    payload += "\"}";

    static const char OP[] = "ipfs.cat";
    if (sdn_host_call_json(OP, sizeof(OP) - 1, payload.c_str(), payload.size()) != 0) {
        return false;
    }

    std::string json;
    if (!read_hostcall_response(json)) {
        return false;
    }
    if (json.find("\"ok\":true") == std::string::npos &&
        json.find("\"ok\": true") == std::string::npos) {
        return false;
    }

    const std::string base64 = json_get_string(json.data(), json.size(), "base64");
    if (!base64.empty()) {
        out_bytes = base64_decode(base64.data(), base64.size());
        return true;
    }

    out_bytes.assign(json.begin(), json.end());
    return true;
}

static bool publish_ipfs_bytes(const std::vector<uint8_t>& bytes, std::string& out_cid) {
    const std::string payload =
        std::string("{\"base64\":\"") + base64_encode(bytes.data(), bytes.size()) + "\"}";

    static const char OP[] = "ipfs.add";
    if (sdn_host_call_json(OP, sizeof(OP) - 1, payload.c_str(), payload.size()) != 0) {
        return false;
    }

    std::string json;
    if (!read_hostcall_response(json)) {
        return false;
    }
    if (json.find("\"ok\":true") == std::string::npos &&
        json.find("\"ok\": true") == std::string::npos) {
        return false;
    }

    out_cid = json_get_string(json.data(), json.size(), "Hash");
    if (out_cid.empty()) {
        out_cid = json_get_string(json.data(), json.size(), "cid");
    }
    if (out_cid.empty()) {
        out_cid = json_get_string(json.data(), json.size(), "path");
    }
    return !out_cid.empty();
}
#else
static bool fetch_ipfs_bytes(const char*, size_t, std::vector<uint8_t>&) {
    return false;
}

static bool publish_ipfs_bytes(const std::vector<uint8_t>&, std::string&) {
    return false;
}
#endif

using namespace orbpro::invoke;
namespace module_delivery = space_data_network::module_delivery::v1;

static flatbuffers::DetachedBuffer build_error_response(const char* msg) {
    flatbuffers::FlatBufferBuilder fbb(256);
    const auto msg_off = fbb.CreateString(msg);
    PluginInvokeResponseBuilder rb(fbb);
    rb.add_status_code(1);
    rb.add_error_message(msg_off);
    FinishPluginInvokeResponseBuffer(fbb, rb.Finish());
    return fbb.Release();
}

static flatbuffers::DetachedBuffer build_bytes_response(const uint8_t* data, size_t len) {
    flatbuffers::FlatBufferBuilder fbb(len + 512);
    const auto arena_vec = fbb.CreateVector(data, len);
    using namespace orbpro::stream;
    TypedArenaBufferBuilder tb(fbb);
    tb.add_offset(0);
    tb.add_size(static_cast<uint32_t>(len));
    const auto frame = tb.Finish();
    const auto frames = fbb.CreateVector(&frame, 1);

    PluginInvokeResponseBuilder rb(fbb);
    rb.add_status_code(0);
    rb.add_output_frames(frames);
    rb.add_payload_arena(arena_vec);
    FinishPluginInvokeResponseBuffer(fbb, rb.Finish());
    return fbb.Release();
}

static flatbuffers::DetachedBuffer handle_deliver_plugin(const PluginInvokeRequest* req) {
    const auto* frames = req->input_frames();
    const auto* arena = req->payload_arena();
    if (!frames || frames->size() < 2) {
        return build_error_response("deliver_plugin requires at least 2 input frames");
    }
    if (!arena) {
        return build_error_response("missing payload arena");
    }

    const auto* key_frame = frames->Get(0);
    const auto* cid_frame = frames->Get(1);
    if (!key_frame || !cid_frame) {
        return build_error_response("missing input frames");
    }
    if (key_frame->size() != KEY_BYTES || key_frame->offset() + key_frame->size() > arena->size()) {
        return build_error_response("client public key must be 32 bytes");
    }
    if (cid_frame->size() == 0 || cid_frame->offset() + cid_frame->size() > arena->size()) {
        return build_error_response("CID is empty");
    }

    const uint8_t* client_pub = arena->data() + key_frame->offset();
    const char* source_cid_ptr = reinterpret_cast<const char*>(arena->data() + cid_frame->offset());
    const std::string source_cid(source_cid_ptr, cid_frame->size());

    DeliveryMetadata metadata;
    if (frames->size() >= 3) {
        const auto* metadata_frame = frames->Get(2);
        if (metadata_frame &&
            metadata_frame->size() > 0 &&
            metadata_frame->offset() + metadata_frame->size() <= arena->size()) {
            metadata = parse_metadata(arena->data() + metadata_frame->offset(), metadata_frame->size(), source_cid);
        }
    }
    if (metadata.req_id.empty()) {
        metadata.req_id = DEFAULT_REQ_ID;
        metadata.module_id = DEFAULT_MODULE_ID;
        metadata.runtime = DEFAULT_RUNTIME;
        metadata.abi = DEFAULT_ABI;
        metadata.entrypoint = DEFAULT_ENTRYPOINT;
        metadata.publication_cid = source_cid;
        metadata.content_codec = DEFAULT_CONTENT_CODEC;
        metadata.encryption_codec = DEFAULT_ENCRYPTION_CODEC;
    }

    std::vector<uint8_t> plugin_bytes;
    if (!fetch_ipfs_bytes(source_cid_ptr, cid_frame->size(), plugin_bytes)) {
        return build_error_response("IPFS fetch failed");
    }
    if (plugin_bytes.empty()) {
        return build_error_response("IPFS returned empty data");
    }

    const EncryptedBundle encrypted = encrypt_bundle_for_recipient(
        plugin_bytes.data(),
        plugin_bytes.size(),
        client_pub,
        KEY_BYTES
    );
    if (!encrypted.ok) {
        return build_error_response(encrypted.error.c_str());
    }

    std::string encrypted_cid;
    if (!publish_ipfs_bytes(encrypted.encrypted_bundle, encrypted_cid)) {
        return build_error_response("IPFS publish failed");
    }

    flatbuffers::FlatBufferBuilder builder(2048);
    const auto req_id = builder.CreateString(metadata.req_id);
    const auto cid = builder.CreateString(encrypted_cid);
    const auto content_hash = builder.CreateVector(encrypted.content_hash.data(), encrypted.content_hash.size());
    const auto module_id = builder.CreateString(metadata.module_id);
    flatbuffers::Offset<flatbuffers::String> module_version;
    if (!metadata.module_version.empty()) {
        module_version = builder.CreateString(metadata.module_version);
    }
    const auto runtime = builder.CreateString(metadata.runtime);
    const auto abi = builder.CreateString(metadata.abi);
    const auto entrypoint = builder.CreateString(metadata.entrypoint);
    const auto publication_cid = builder.CreateString(metadata.publication_cid);
    const auto content_codec = builder.CreateString(metadata.content_codec);
    const auto encryption_codec = builder.CreateString(metadata.encryption_codec);
    const auto wrapping_algorithm = builder.CreateString(WRAP_ALGORITHM);
    const auto recipient_key_id = builder.CreateString(bytes_to_hex(client_pub, KEY_BYTES));
    const auto recipient_public_key = builder.CreateVector(client_pub, KEY_BYTES);
    const auto ephemeral_public_key = builder.CreateVector(
        encrypted.ephemeral_public_key.data(),
        encrypted.ephemeral_public_key.size()
    );
    const auto wrap_nonce = builder.CreateVector(encrypted.wrap_nonce.data(), encrypted.wrap_nonce.size());
    const auto wrapped_ciphertext = builder.CreateVector(
        encrypted.wrapped_ciphertext.data(),
        encrypted.wrapped_ciphertext.size()
    );
    const auto wrapped_tag = builder.CreateVector(
        encrypted.wrapped_tag.data(),
        encrypted.wrapped_tag.size()
    );

    module_delivery::BundleDescriptorBuilder descriptor_builder(builder);
    descriptor_builder.add_schema_version(1);
    descriptor_builder.add_cid(cid);
    descriptor_builder.add_content_hash(content_hash);
    descriptor_builder.add_size_bytes(encrypted.encrypted_bundle.size());
    descriptor_builder.add_module_id(module_id);
    if (!metadata.module_version.empty()) descriptor_builder.add_module_version(module_version);
    descriptor_builder.add_runtime(runtime);
    descriptor_builder.add_abi(abi);
    descriptor_builder.add_entrypoint(entrypoint);
    descriptor_builder.add_publication_cid(publication_cid);
    descriptor_builder.add_content_codec(content_codec);
    descriptor_builder.add_encryption_codec(encryption_codec);
    const auto descriptor = descriptor_builder.Finish();

    module_delivery::WrappedContentKeyBuilder wrapped_builder(builder);
    wrapped_builder.add_schema_version(1);
    wrapped_builder.add_wrapping_algorithm(wrapping_algorithm);
    wrapped_builder.add_recipient_key_id(recipient_key_id);
    wrapped_builder.add_recipient_public_key(recipient_public_key);
    wrapped_builder.add_ephemeral_public_key(ephemeral_public_key);
    wrapped_builder.add_nonce(wrap_nonce);
    wrapped_builder.add_ciphertext(wrapped_ciphertext);
    wrapped_builder.add_tag(wrapped_tag);
    const auto wrapped_content_key = wrapped_builder.Finish();

    module_delivery::GrantResponseBuilder grant_builder(builder);
    grant_builder.add_schema_version(1);
    grant_builder.add_req_id(req_id);
    grant_builder.add_bundle_descriptor(descriptor);
    grant_builder.add_wrapped_content_key(wrapped_content_key);
    const auto grant = grant_builder.Finish();
    module_delivery::FinishGrantResponseBuffer(builder, grant);

    return build_bytes_response(builder.GetBufferPointer(), builder.GetSize());
}

static flatbuffers::DetachedBuffer handle_get_public_key() {
    uint8_t pub[32];
    derive_server_public_key(pub);
    return build_bytes_response(pub, sizeof(pub));
}

extern "C" {

__attribute__((visibility("default")))
uint8_t* plugin_alloc(uint32_t size) {
    return static_cast<uint8_t*>(malloc(size));
}

__attribute__((visibility("default")))
void plugin_free(uint8_t* ptr, uint32_t) {
    free(ptr);
}

__attribute__((visibility("default")))
uint8_t* plugin_invoke_stream(const uint8_t* req_ptr, uint32_t req_len, uint32_t* out_len_ptr) {
    if (!req_ptr || req_len == 0 || !out_len_ptr) {
        if (out_len_ptr) {
            *out_len_ptr = 0;
        }
        return nullptr;
    }

    flatbuffers::Verifier verifier(req_ptr, req_len);
    if (!VerifyPluginInvokeRequestBuffer(verifier)) {
        *out_len_ptr = 0;
        return nullptr;
    }
    const PluginInvokeRequest* req = GetPluginInvokeRequest(req_ptr);
    const char* method = req->method_id() ? req->method_id()->c_str() : "";

    flatbuffers::DetachedBuffer response;
    if (strcmp(method, "deliver_plugin") == 0) {
        response = handle_deliver_plugin(req);
    } else if (strcmp(method, "get_public_key") == 0) {
        response = handle_get_public_key();
    } else {
        response = build_error_response("unknown method");
    }

    const uint32_t response_len = static_cast<uint32_t>(response.size());
    uint8_t* response_ptr = static_cast<uint8_t*>(malloc(response_len));
    if (!response_ptr) {
        *out_len_ptr = 0;
        return nullptr;
    }
    memcpy(response_ptr, response.data(), response_len);
    *out_len_ptr = response_len;
    return response_ptr;
}

}  // extern "C"
