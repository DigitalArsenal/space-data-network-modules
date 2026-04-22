/**
 * SDN Client Decrypt Module (C++ / Crypto++)
 *
 * Decrypts either the legacy JSON envelope format or the canonical
 * module-delivery GrantResponse format. For GrantResponse inputs the module
 * fetches the encrypted bundle over IPFS through the sync sdn_host bridge.
 */

#include <stdint.h>
#include <stddef.h>
#include <string.h>
#include <stdlib.h>

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

static const char WRAP_INFOS[][64] = {
    "orbpro-key-server-artifact-wrap-v1",
    "plugin-key-server-artifact-wrap-v1",
};
static const size_t WRAP_INFO_COUNT = 2;
static const char MODULE_DELIVERY_WRAP_INFO[] = "space-data-network/module-delivery/wrap/v1";
static const size_t KEY_BYTES = 32;
static const size_t GCM_IV_BYTES = 12;
static const size_t GCM_TAG_BYTES = 16;

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

static int b64_char_value(char c) {
    if (c >= 'A' && c <= 'Z') return c - 'A';
    if (c >= 'a' && c <= 'z') return c - 'a' + 26;
    if (c >= '0' && c <= '9') return c - '0' + 52;
    if (c == '+' || c == '-') return 62;
    if (c == '/' || c == '_') return 63;
    return -1;
}

static std::vector<uint8_t> base64_decode(const char* in, size_t in_len) {
    std::vector<uint8_t> out;
    out.reserve(in_len * 3 / 4);
    int val = 0;
    int bits = -8;
    for (size_t i = 0; i < in_len; i++) {
        const int v = b64_char_value(in[i]);
        if (v < 0) {
            continue;
        }
        val = (val << 6) + v;
        bits += 6;
        if (bits >= 0) {
            out.push_back(static_cast<uint8_t>((val >> bits) & 0xff));
            bits -= 8;
        }
    }
    return out;
}

static std::vector<uint8_t> hex_decode(const char* in, size_t in_len) {
    std::vector<uint8_t> out;
    out.reserve(in_len / 2);
    for (size_t i = 0; i + 1 < in_len; i += 2) {
        auto nibble = [](char c) -> int {
            if (c >= '0' && c <= '9') return c - '0';
            if (c >= 'a' && c <= 'f') return c - 'a' + 10;
            if (c >= 'A' && c <= 'F') return c - 'A' + 10;
            return -1;
        };
        const int hi = nibble(in[i]);
        const int lo = nibble(in[i + 1]);
        if (hi < 0 || lo < 0) {
            break;
        }
        out.push_back(static_cast<uint8_t>((hi << 4) | lo));
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

struct DecryptResult {
    bool ok = false;
    std::vector<uint8_t> plaintext;
    std::string error;
};

static DecryptResult decrypt_legacy_envelope(
    const char* envelope_json,
    size_t json_len,
    const uint8_t* priv_key,
    size_t priv_len)
{
    DecryptResult result;
    if (priv_len != KEY_BYTES) {
        result.error = "private key must be 32 bytes";
        return result;
    }

    const auto eph_pub_hex = json_get_string(envelope_json, json_len, "ephemeralPublicKeyHex");
    const auto hkdf_salt_b64 = json_get_string(envelope_json, json_len, "hkdfSaltB64");
    const auto wrap_iv_b64 = json_get_string(envelope_json, json_len, "wrapIvB64");
    const auto wrapped_key_b64 = json_get_string(envelope_json, json_len, "wrappedKeyB64");
    const auto wrapped_tag_b64 = json_get_string(envelope_json, json_len, "wrappedKeyTagB64");
    const auto content_iv_b64 = json_get_string(envelope_json, json_len, "ivB64");
    const auto content_tag_b64 = json_get_string(envelope_json, json_len, "tagB64");
    const auto ciphertext_b64 = json_get_string(envelope_json, json_len, "ciphertextB64");

    if (eph_pub_hex.empty() || hkdf_salt_b64.empty() || wrap_iv_b64.empty() ||
        wrapped_key_b64.empty() || wrapped_tag_b64.empty() ||
        content_iv_b64.empty() || content_tag_b64.empty() || ciphertext_b64.empty()) {
        result.error = "missing envelope fields";
        return result;
    }

    const auto eph_pub_bytes = hex_decode(eph_pub_hex.data(), eph_pub_hex.size());
    const auto hkdf_salt = base64_decode(hkdf_salt_b64.data(), hkdf_salt_b64.size());
    const auto wrap_iv = base64_decode(wrap_iv_b64.data(), wrap_iv_b64.size());
    const auto wrapped_key = base64_decode(wrapped_key_b64.data(), wrapped_key_b64.size());
    const auto wrapped_tag = base64_decode(wrapped_tag_b64.data(), wrapped_tag_b64.size());
    const auto content_iv = base64_decode(content_iv_b64.data(), content_iv_b64.size());
    const auto content_tag = base64_decode(content_tag_b64.data(), content_tag_b64.size());
    const auto ciphertext = base64_decode(ciphertext_b64.data(), ciphertext_b64.size());

    if (eph_pub_bytes.size() != KEY_BYTES) {
        result.error = "invalid ephemeral public key";
        return result;
    }

    try {
        CryptoPP::x25519 x25519_scheme;
        CryptoPP::SecByteBlock shared_secret(KEY_BYTES);
        if (!x25519_scheme.Agree(shared_secret, priv_key, eph_pub_bytes.data())) {
            result.error = "X25519 key agreement failed";
            return result;
        }

        CryptoPP::SecByteBlock content_key(KEY_BYTES);
        bool unwrapped = false;
        for (size_t i = 0; i < WRAP_INFO_COUNT && !unwrapped; i++) {
            CryptoPP::SecByteBlock wrap_key(KEY_BYTES);
            CryptoPP::HKDF<CryptoPP::SHA256> hkdf;
            hkdf.DeriveKey(
                wrap_key, KEY_BYTES,
                shared_secret, KEY_BYTES,
                hkdf_salt.data(), hkdf_salt.size(),
                reinterpret_cast<const uint8_t*>(WRAP_INFOS[i]),
                strlen(WRAP_INFOS[i])
            );

            std::vector<uint8_t> wrapped_combined;
            wrapped_combined.reserve(wrapped_key.size() + wrapped_tag.size());
            wrapped_combined.insert(wrapped_combined.end(), wrapped_key.begin(), wrapped_key.end());
            wrapped_combined.insert(wrapped_combined.end(), wrapped_tag.begin(), wrapped_tag.end());

            try {
                CryptoPP::GCM<CryptoPP::AES>::Decryption dec;
                dec.SetKeyWithIV(wrap_key, KEY_BYTES, wrap_iv.data(), wrap_iv.size());
                CryptoPP::ArraySink sink(content_key, KEY_BYTES);
                CryptoPP::AuthenticatedDecryptionFilter filter(
                    dec,
                    &sink,
                    CryptoPP::AuthenticatedDecryptionFilter::DEFAULT_FLAGS,
                    GCM_TAG_BYTES
                );
                filter.Put(wrapped_combined.data(), wrapped_combined.size());
                filter.MessageEnd();
                unwrapped = true;
            } catch (...) {
            }
        }

        if (!unwrapped) {
            result.error = "failed to unwrap content key with any HKDF info string";
            return result;
        }

        std::vector<uint8_t> ciphertext_and_tag;
        ciphertext_and_tag.reserve(ciphertext.size() + content_tag.size());
        ciphertext_and_tag.insert(ciphertext_and_tag.end(), ciphertext.begin(), ciphertext.end());
        ciphertext_and_tag.insert(ciphertext_and_tag.end(), content_tag.begin(), content_tag.end());

        result.plaintext.resize(ciphertext.size());
        CryptoPP::GCM<CryptoPP::AES>::Decryption dec;
        dec.SetKeyWithIV(content_key, KEY_BYTES, content_iv.data(), content_iv.size());
        CryptoPP::ArraySink sink(result.plaintext.data(), result.plaintext.size());
        CryptoPP::AuthenticatedDecryptionFilter filter(
            dec,
            &sink,
            CryptoPP::AuthenticatedDecryptionFilter::DEFAULT_FLAGS,
            GCM_TAG_BYTES
        );
        filter.Put(ciphertext_and_tag.data(), ciphertext_and_tag.size());
        filter.MessageEnd();
        result.ok = true;
    } catch (const std::exception& ex) {
        result.error = ex.what();
        result.plaintext.clear();
    }

    return result;
}

#if defined(SDN_WASI_PLUGIN)
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
#else
static bool fetch_ipfs_bytes(const char*, size_t, std::vector<uint8_t>&) {
    return false;
}
#endif

namespace module_delivery = space_data_network::module_delivery::v1;

static DecryptResult decrypt_grant_response(
    const uint8_t* grant_bytes,
    size_t grant_len,
    const uint8_t* encrypted_bundle_bytes,
    size_t encrypted_bundle_len,
    const uint8_t* priv_key,
    size_t priv_len)
{
    DecryptResult result;
    if (priv_len != KEY_BYTES) {
        result.error = "private key must be 32 bytes";
        return result;
    }
    if (!module_delivery::GrantResponseBufferHasIdentifier(grant_bytes)) {
        result.error = "invalid grant response identifier";
        return result;
    }

    flatbuffers::Verifier verifier(grant_bytes, grant_len);
    if (!module_delivery::VerifyGrantResponseBuffer(verifier)) {
        result.error = "invalid grant response buffer";
        return result;
    }

    const module_delivery::GrantResponse* grant =
        module_delivery::GetGrantResponse(grant_bytes);
    const module_delivery::BundleDescriptor* descriptor = grant->bundle_descriptor();
    const module_delivery::WrappedContentKey* wrapped = grant->wrapped_content_key();
    if (!descriptor || !wrapped || !descriptor->cid()) {
        result.error = "grant response missing required fields";
        return result;
    }

    const auto* ephemeral_public_key = wrapped->ephemeral_public_key();
    const auto* nonce = wrapped->nonce();
    const auto* ciphertext = wrapped->ciphertext();
    const auto* tag = wrapped->tag();
    if (!ephemeral_public_key || !nonce || !ciphertext || !tag) {
        result.error = "wrapped content key missing required bytes";
        return result;
    }
    if (ephemeral_public_key->size() != KEY_BYTES) {
        result.error = "wrapped ephemeral public key must be 32 bytes";
        return result;
    }

    std::vector<uint8_t> encrypted_bundle;
    if (encrypted_bundle_bytes != nullptr && encrypted_bundle_len > 0) {
        encrypted_bundle.assign(
            encrypted_bundle_bytes,
            encrypted_bundle_bytes + encrypted_bundle_len
        );
    } else {
        const auto* cid = descriptor->cid();
        if (!fetch_ipfs_bytes(cid->c_str(), cid->size(), encrypted_bundle)) {
            result.error = "IPFS fetch failed";
            return result;
        }
    }
    if (encrypted_bundle.size() <= GCM_IV_BYTES + GCM_TAG_BYTES) {
        result.error = "encrypted bundle is too small";
        return result;
    }

    try {
        CryptoPP::x25519 x25519_scheme;
        CryptoPP::SecByteBlock shared_secret(KEY_BYTES);
        if (!x25519_scheme.Agree(shared_secret, priv_key, ephemeral_public_key->Data())) {
            result.error = "X25519 key agreement failed";
            return result;
        }

        CryptoPP::SecByteBlock wrap_key(KEY_BYTES);
        CryptoPP::HKDF<CryptoPP::SHA256> hkdf;
        hkdf.DeriveKey(
            wrap_key, KEY_BYTES,
            shared_secret, KEY_BYTES,
            nullptr, 0,
            reinterpret_cast<const uint8_t*>(MODULE_DELIVERY_WRAP_INFO),
            sizeof(MODULE_DELIVERY_WRAP_INFO) - 1
        );

        std::vector<uint8_t> wrapped_key_and_tag;
        wrapped_key_and_tag.reserve(ciphertext->size() + tag->size());
        wrapped_key_and_tag.insert(
            wrapped_key_and_tag.end(),
            ciphertext->begin(),
            ciphertext->end()
        );
        wrapped_key_and_tag.insert(
            wrapped_key_and_tag.end(),
            tag->begin(),
            tag->end()
        );

        std::vector<uint8_t> content_key(KEY_BYTES);
        {
            CryptoPP::GCM<CryptoPP::AES>::Decryption dec;
            dec.SetKeyWithIV(wrap_key, KEY_BYTES, nonce->Data(), nonce->size());
            CryptoPP::ArraySink sink(content_key.data(), content_key.size());
            CryptoPP::AuthenticatedDecryptionFilter filter(
                dec,
                &sink,
                CryptoPP::AuthenticatedDecryptionFilter::DEFAULT_FLAGS,
                GCM_TAG_BYTES
            );
            filter.Put(wrapped_key_and_tag.data(), wrapped_key_and_tag.size());
            filter.MessageEnd();
        }

        const uint8_t* content_iv = encrypted_bundle.data();
        const size_t ciphertext_len = encrypted_bundle.size() - GCM_IV_BYTES - GCM_TAG_BYTES;
        const uint8_t* content_ciphertext = encrypted_bundle.data() + GCM_IV_BYTES;
        const uint8_t* content_tag = encrypted_bundle.data() + GCM_IV_BYTES + ciphertext_len;
        std::vector<uint8_t> ciphertext_and_tag;
        ciphertext_and_tag.reserve(ciphertext_len + GCM_TAG_BYTES);
        ciphertext_and_tag.insert(
            ciphertext_and_tag.end(),
            content_ciphertext,
            content_ciphertext + ciphertext_len
        );
        ciphertext_and_tag.insert(
            ciphertext_and_tag.end(),
            content_tag,
            content_tag + GCM_TAG_BYTES
        );

        result.plaintext.resize(ciphertext_len);
        CryptoPP::GCM<CryptoPP::AES>::Decryption dec;
        dec.SetKeyWithIV(content_key.data(), content_key.size(), content_iv, GCM_IV_BYTES);
        CryptoPP::ArraySink sink(result.plaintext.data(), result.plaintext.size());
        CryptoPP::AuthenticatedDecryptionFilter filter(
            dec,
            &sink,
            CryptoPP::AuthenticatedDecryptionFilter::DEFAULT_FLAGS,
            GCM_TAG_BYTES
        );
        filter.Put(ciphertext_and_tag.data(), ciphertext_and_tag.size());
        filter.MessageEnd();
        result.ok = true;
    } catch (const std::exception& ex) {
        result.error = ex.what();
        result.plaintext.clear();
    }

    return result;
}

using namespace orbpro::invoke;

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

static flatbuffers::DetachedBuffer handle_decrypt_artifact(const PluginInvokeRequest* req) {
    const auto* frames = req->input_frames();
    const auto* arena = req->payload_arena();
    if (!frames || frames->size() < 2 || frames->size() > 3) {
        return build_error_response("decrypt_artifact requires 2 or 3 input frames");
    }
    if (!arena) {
        return build_error_response("missing payload arena");
    }

    const auto* payload_frame = frames->Get(0);
    const auto* key_frame = frames->Get(1);
    const auto* encrypted_bundle_frame = frames->size() > 2 ? frames->Get(2) : nullptr;
    if (!payload_frame || !key_frame) {
        return build_error_response("missing input frames");
    }
    if (payload_frame->offset() + payload_frame->size() > arena->size() ||
        key_frame->offset() + key_frame->size() > arena->size() ||
        (encrypted_bundle_frame &&
            encrypted_bundle_frame->offset() + encrypted_bundle_frame->size() > arena->size())) {
        return build_error_response("input frame exceeds payload arena");
    }

    const uint8_t* payload = arena->data() + payload_frame->offset();
    const size_t payload_len = payload_frame->size();
    const uint8_t* private_key = arena->data() + key_frame->offset();
    const size_t private_key_len = key_frame->size();
    const uint8_t* encrypted_bundle = encrypted_bundle_frame
        ? arena->data() + encrypted_bundle_frame->offset()
        : nullptr;
    const size_t encrypted_bundle_len = encrypted_bundle_frame
        ? encrypted_bundle_frame->size()
        : 0;

    DecryptResult decrypted;
    if (payload_len >= 8 && module_delivery::GrantResponseBufferHasIdentifier(payload)) {
        decrypted = decrypt_grant_response(
            payload,
            payload_len,
            encrypted_bundle,
            encrypted_bundle_len,
            private_key,
            private_key_len
        );
    } else {
        decrypted = decrypt_legacy_envelope(
            reinterpret_cast<const char*>(payload),
            payload_len,
            private_key,
            private_key_len
        );
    }

    if (!decrypted.ok) {
        return build_error_response(decrypted.error.c_str());
    }
    return build_bytes_response(decrypted.plaintext.data(), decrypted.plaintext.size());
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
    if (strcmp(method, "decrypt_artifact") == 0) {
        response = handle_decrypt_artifact(req);
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
