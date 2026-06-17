/**
 * SDN Plugin Delivery Module (C++ / Crypto++)
 *
 * Fetches a plugin artifact from IPFS, encrypts it for the recipient, publishes
 * the encrypted bundle over IPFS, and returns a canonical SDS `$LGR`
 * module-delivery grant FlatBuffer.
 */

#include <stdint.h>
#include <stddef.h>
#include <string.h>
#include <stdlib.h>

#include <algorithm>
#include <array>
#include <chrono>
#include <memory>
#include <string>
#include <vector>

// Emscripten's sysroot defines TIME_UTC as a macro; SDS generated headers also
// contain fields with that exact name.
#ifdef TIME_UTC
#undef TIME_UTC
#endif

#include <flatbuffers/flatbuffers.h>
#include "ENC_generated.h"
#include "KMF_generated.h"
#include "LGR_generated.h"
#include "PIV_generated.h"
#include "PLG_generated.h"
#include "REC_generated.h"

#include <cryptopp/aes.h>
#include <cryptopp/gcm.h>
#include <cryptopp/hkdf.h>
#include <cryptopp/modes.h>
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
#include "../../../common/sdm_hostcall_wire.hpp"
#endif

static const uint8_t SERVER_PRIVATE_KEY[32] = { SDN_BAKED_SERVER_PRIVATE_KEY };

static const char GRANT_PAYLOAD_CONTEXT[] = "space-data-network/module-delivery/grant/v1";
static const char DEFAULT_REQ_ID[] = "deliver_plugin";
static const char DEFAULT_MODULE_ID[] = "module";
static const char DEFAULT_REQUIRED_SCOPE[] = "orbpro:module:use";
static const char DEFAULT_RUNTIME[] = "wasm";
static const char DEFAULT_ABI[] = "module-sdk/async-host-v1";
static const char DEFAULT_ENTRYPOINT[] = "plugin_invoke_stream";
static const char DEFAULT_CONTENT_CODEC[] = "application/wasm+encrypted";
static const char DEFAULT_ENCRYPTION_CODEC[] = "x25519-hkdf-sha256-aes-256-gcm";
static const size_t KEY_BYTES = 32;
static const size_t GCM_IV_BYTES = 12;
static const size_t GCM_TAG_BYTES = 16;
static const size_t RECIPIENT_KEY_ID_BYTES = 8;
static const uint16_t KMF_KEY_BYTES_FIELD_ID = 4;


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
    std::string granted_domain;
    uint64_t granted_timeout_ms = 30000;
    uint64_t expires_at_ms = 0;
};

static uint64_t current_time_ms() {
    using namespace std::chrono;
    return static_cast<uint64_t>(
        duration_cast<milliseconds>(system_clock::now().time_since_epoch()).count()
    );
}

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
    if (metadata.granted_domain.empty()) metadata.granted_domain = "localhost";
    if (metadata.expires_at_ms == 0) {
        metadata.expires_at_ms = current_time_ms() + metadata.granted_timeout_ms;
    }
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

static void derive_hkdf_key(
    const uint8_t* ikm,
    size_t ikm_len,
    const uint8_t* info,
    size_t info_len,
    uint8_t* out,
    size_t out_len)
{
    CryptoPP::HKDF<CryptoPP::SHA256> hkdf;
    hkdf.DeriveKey(out, out_len, ikm, ikm_len, nullptr, 0, info, info_len);
}

static void derive_field_key(
    const uint8_t* master_key,
    uint16_t field_id,
    uint32_t record_index,
    uint8_t* out_key)
{
    uint8_t info[32] = "flatbuffers-field";
    info[17] = static_cast<uint8_t>(field_id >> 8);
    info[18] = static_cast<uint8_t>(field_id & 0xff);
    info[19] = static_cast<uint8_t>((record_index >> 24) & 0xff);
    info[20] = static_cast<uint8_t>((record_index >> 16) & 0xff);
    info[21] = static_cast<uint8_t>((record_index >> 8) & 0xff);
    info[22] = static_cast<uint8_t>(record_index & 0xff);
    derive_hkdf_key(master_key, KEY_BYTES, info, 23, out_key, KEY_BYTES);
}

static void derive_field_iv(
    const uint8_t* master_key,
    uint16_t field_id,
    uint32_t record_index,
    uint8_t* out_iv)
{
    uint8_t info[32] = "flatbuffers-iv";
    info[14] = static_cast<uint8_t>(field_id >> 8);
    info[15] = static_cast<uint8_t>(field_id & 0xff);
    info[16] = static_cast<uint8_t>((record_index >> 24) & 0xff);
    info[17] = static_cast<uint8_t>((record_index >> 16) & 0xff);
    info[18] = static_cast<uint8_t>((record_index >> 8) & 0xff);
    info[19] = static_cast<uint8_t>(record_index & 0xff);
    derive_hkdf_key(master_key, KEY_BYTES, info, 20, out_iv, 16);
}

static void aes_ctr_xor(
    uint8_t* data,
    size_t data_len,
    const uint8_t* key,
    const uint8_t* iv)
{
    CryptoPP::CTR_Mode<CryptoPP::AES>::Encryption ctr;
    ctr.SetKeyWithIV(key, KEY_BYTES, iv, 16);
    ctr.ProcessData(data, data, data_len);
}

static std::vector<uint8_t> build_wrapped_content_key_payload(
    const char* key_id,
    const uint8_t* content_key,
    size_t content_key_len,
    uint64_t expires_at_ms,
    const uint8_t* payload_key)
{
    std::vector<uint8_t> payload;
    if (!content_key || content_key_len != KEY_BYTES || !payload_key) {
        return payload;
    }

    flatbuffers::FlatBufferBuilder builder(512);
    const auto key_id_offset = builder.CreateString(key_id ? key_id : "content");
    const auto key_bytes_offset = builder.CreateVector(content_key, content_key_len);
    const auto kmf_offset = CreateKMF(
        builder,
        key_id_offset,
        keyMaterialRole::PublicationContent,
        keyMaterialAlgorithm::Aes256Gcm,
        keyMaterialEncoding::RawBytes,
        key_bytes_offset,
        1,
        expires_at_ms);
    const auto standard_offset = builder.CreateString("KMF");
    const auto record_offset = CreateRecord(
        builder,
        RecordType::KMF,
        kmf_offset.Union(),
        standard_offset);
    const std::array<flatbuffers::Offset<Record>, 1> records = {record_offset};
    const auto records_offset = builder.CreateVector(records.data(), records.size());
    const auto version_offset = builder.CreateString("1.0");
    const auto rec_offset = CreateREC(builder, version_offset, records_offset);
    FinishRECBuffer(builder, rec_offset);

    payload.assign(
        builder.GetBufferPointer(),
        builder.GetBufferPointer() + builder.GetSize());

    auto* rec = const_cast<REC*>(GetREC(payload.data()));
    const auto* record = rec && rec->RECORDS() && rec->RECORDS()->size() == 1
        ? rec->RECORDS()->Get(0)
        : nullptr;
    const auto* kmf = record ? record->value_as_KMF() : nullptr;
    auto* key_bytes = kmf
        ? const_cast<flatbuffers::Vector<uint8_t>*>(kmf->KEY_BYTES())
        : nullptr;
    if (!key_bytes || key_bytes->size() != KEY_BYTES) {
        payload.clear();
        return payload;
    }

    std::array<uint8_t, KEY_BYTES> field_key{};
    std::array<uint8_t, 16> field_iv{};
    derive_field_key(payload_key, KMF_KEY_BYTES_FIELD_ID, 0, field_key.data());
    derive_field_iv(payload_key, KMF_KEY_BYTES_FIELD_ID, 0, field_iv.data());
    aes_ctr_xor(key_bytes->Data(), key_bytes->size(), field_key.data(), field_iv.data());
    memset(field_key.data(), 0, field_key.size());
    memset(field_iv.data(), 0, field_iv.size());
    return payload;
}

struct EncryptedBundle {
    bool ok = false;
    std::vector<uint8_t> encrypted_bundle;
    std::array<uint8_t, 32> encrypted_content_hash{};
    std::array<uint8_t, 32> plaintext_content_hash{};
    std::array<uint8_t, 32> provider_ephemeral_public_key{};
    std::array<uint8_t, GCM_IV_BYTES> nonce_start{};
    std::array<uint8_t, RECIPIENT_KEY_ID_BYTES> recipient_key_id{};
    std::vector<uint8_t> wrapped_payload;
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

    std::array<uint8_t, KEY_BYTES> payload_key{};
    derive_hkdf_key(
        shared_secret,
        shared_secret.size(),
        reinterpret_cast<const uint8_t*>(GRANT_PAYLOAD_CONTEXT),
        sizeof(GRANT_PAYLOAD_CONTEXT) - 1,
        payload_key.data(),
        payload_key.size());

    CryptoPP::SecByteBlock content_key(KEY_BYTES);
    rng.GenerateBlock(content_key, KEY_BYTES);

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
    rng.GenerateBlock(out.nonce_start.data(), out.nonce_start.size());
    sha256_bytes(plaintext, plaintext_len, out.plaintext_content_hash.data());
    sha256_bytes(
        out.encrypted_bundle.data(),
        out.encrypted_bundle.size(),
        out.encrypted_content_hash.data());
    std::array<uint8_t, 32> recipient_hash{};
    sha256_bytes(recipient_pub_key, recipient_pub_len, recipient_hash.data());
    std::copy_n(
        recipient_hash.begin(),
        out.recipient_key_id.size(),
        out.recipient_key_id.begin());
    std::copy(
        ephemeral_public.begin(),
        ephemeral_public.end(),
        out.provider_ephemeral_public_key.begin());
    out.wrapped_payload = build_wrapped_content_key_payload(
        "publication-content",
        content_key.BytePtr(),
        KEY_BYTES,
        0,
        payload_key.data());
    if (out.wrapped_payload.empty()) {
        out.error = "failed to build SDS wrapped content key payload";
        memset(payload_key.data(), 0, payload_key.size());
        memset(content_key.BytePtr(), 0, content_key.size());
        memset(shared_secret.BytePtr(), 0, shared_secret.size());
        memset(ephemeral_private.BytePtr(), 0, ephemeral_private.size());
        return out;
    }
    memset(payload_key.data(), 0, payload_key.size());
    memset(content_key.BytePtr(), 0, content_key.size());
    memset(shared_secret.BytePtr(), 0, shared_secret.size());
    memset(ephemeral_private.BytePtr(), 0, ephemeral_private.size());
    out.ok = true;
    return out;
}

#if defined(SDN_WASI_PLUGIN)
static bool host_random_fill(uint8_t* output, size_t size) {
    const std::string meta =
        std::string("{\"length\":") + std::to_string(size) + "}";
    sdm_hostcall::Response response;
    if (!sdm_hostcall::call("random.bytes", meta, {}, &response)) {
        return false;
    }
    std::vector<uint8_t> bytes;
    if (!sdm_hostcall::get_result_bytes(response, &bytes) || bytes.size() != size) {
        return false;
    }
    memcpy(output, bytes.data(), size);
    return true;
}

static bool fetch_ipfs_bytes(const char* cid, size_t cid_len, std::vector<uint8_t>& out_bytes) {
    std::string meta = "{\"cid\":\"";
    meta.append(cid, cid_len);
    meta += "\"}";

    sdm_hostcall::Response response;
    if (!sdm_hostcall::call("ipfs.cat", meta, {}, &response)) {
        return false;
    }
    return sdm_hostcall::get_result_bytes(response, &out_bytes);
}

static bool publish_ipfs_bytes(const std::vector<uint8_t>& bytes, std::string& out_cid) {
    sdm_hostcall::Response response;
    if (!sdm_hostcall::call(
            "ipfs.add",
            "{\"content\":{\"$bin\":0}}",
            {{bytes.data(), bytes.size()}},
            &response)) {
        return false;
    }

    const std::string& meta = response.meta;
    out_cid = json_get_string(meta.data(), meta.size(), "Hash");
    if (out_cid.empty()) {
        out_cid = json_get_string(meta.data(), meta.size(), "cid");
    }
    if (out_cid.empty()) {
        out_cid = json_get_string(meta.data(), meta.size(), "path");
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

static flatbuffers::DetachedBuffer build_error_response(const char* msg) {
    flatbuffers::FlatBufferBuilder fbb(256);
    const auto code_off = fbb.CreateString("invoke-error");
    const auto msg_off = fbb.CreateString(msg);
    const auto response = CreatePIVResponse(
        fbb,
        1,
        pivStatus::FAILED,
        false,
        0,
        0,
        0,
        code_off,
        msg_off,
        0);
    const auto root = CreatePIV(fbb, 0, response);
    FinishPIVBuffer(fbb, root);
    return fbb.Release();
}

static flatbuffers::DetachedBuffer build_bytes_response(const uint8_t* data, size_t len) {
    flatbuffers::FlatBufferBuilder fbb(len + 512);
    const auto arena_vec = fbb.CreateVector(data, len);
    const auto port = fbb.CreateString("response");
    const auto frame = CreateTAB(
        fbb,
        0,
        static_cast<uint32_t>(len),
        1,
        payloadWireFormat::FLATBUFFER,
        0,
        bufferMutability::IMMUTABLE,
        bufferOwnership::HOST_OWNED,
        0,
        port);
    const auto frames = fbb.CreateVector(&frame, 1);

    const auto response = CreatePIVResponse(
        fbb,
        0,
        pivStatus::OK,
        false,
        0,
        frames,
        arena_vec,
        0,
        0,
        0);
    const auto root = CreatePIV(fbb, 0, response);
    FinishPIVBuffer(fbb, root);
    return fbb.Release();
}

static flatbuffers::DetachedBuffer handle_deliver_plugin(const PIVRequest* req) {
    const auto* frames = req->INPUTS();
    const auto* arena = req->PAYLOAD_ARENA();
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
    if (key_frame->SIZE() != KEY_BYTES || key_frame->OFFSET() + key_frame->SIZE() > arena->size()) {
        return build_error_response("client public key must be 32 bytes");
    }
    if (cid_frame->SIZE() == 0 || cid_frame->OFFSET() + cid_frame->SIZE() > arena->size()) {
        return build_error_response("CID is empty");
    }

    const uint8_t* client_pub = arena->data() + key_frame->OFFSET();
    const char* source_cid_ptr = reinterpret_cast<const char*>(arena->data() + cid_frame->OFFSET());
    const std::string source_cid(source_cid_ptr, cid_frame->SIZE());

    DeliveryMetadata metadata;
    if (frames->size() >= 3) {
        const auto* metadata_frame = frames->Get(2);
        if (metadata_frame &&
            metadata_frame->SIZE() > 0 &&
            metadata_frame->OFFSET() + metadata_frame->SIZE() <= arena->size()) {
            metadata = parse_metadata(arena->data() + metadata_frame->OFFSET(), metadata_frame->SIZE(), source_cid);
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
    if (!fetch_ipfs_bytes(source_cid_ptr, cid_frame->SIZE(), plugin_bytes)) {
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

    flatbuffers::FlatBufferBuilder builder(4096);
    PLGT descriptor{};
    descriptor.PLUGIN_ID = metadata.module_id;
    descriptor.NAME = metadata.module_id;
    descriptor.VERSION = metadata.module_version.empty() ? "1.0.0" : metadata.module_version;
    descriptor.WASM_HASH.assign(
        encrypted.plaintext_content_hash.begin(),
        encrypted.plaintext_content_hash.end());
    descriptor.WASM_SIZE = static_cast<uint64_t>(plugin_bytes.size());
    descriptor.WASM_CID = encrypted_cid;
    descriptor.ENCRYPTED_WASM_HASH.assign(
        encrypted.encrypted_content_hash.begin(),
        encrypted.encrypted_content_hash.end());
    descriptor.ENCRYPTED_WASM_SIZE =
        static_cast<uint64_t>(encrypted.encrypted_bundle.size());
    descriptor.ENCRYPTED = true;
    descriptor.REQUIRED_SCOPE = DEFAULT_REQUIRED_SCOPE;
    descriptor.KEY_ID = "publication-content";
    descriptor.ALLOWED_DOMAINS = {metadata.granted_domain};
    descriptor.MAX_GRANT_TIMEOUT_MS = metadata.granted_timeout_ms;
    const auto descriptor_offset = CreatePLG(builder, &descriptor);

    const auto provider_ephemeral_public_key = builder.CreateVector(
        encrypted.provider_ephemeral_public_key.data(),
        encrypted.provider_ephemeral_public_key.size());
    const auto nonce_start = builder.CreateVector(
        encrypted.nonce_start.data(),
        encrypted.nonce_start.size());
    const auto recipient_key_id = builder.CreateVector(
        encrypted.recipient_key_id.data(),
        encrypted.recipient_key_id.size());
    const auto context = builder.CreateString(GRANT_PAYLOAD_CONTEXT);
    const auto root_type = builder.CreateString("REC");
    const auto wrapped_header = CreateENC(
        builder,
        1,
        KeyExchange::X25519,
        SymmetricAlgo::AES_256_CTR,
        KDF::HKDF_SHA256,
        provider_ephemeral_public_key,
        nonce_start,
        recipient_key_id,
        context,
        0,
        root_type,
        0);
    const auto wrapped_payload = builder.CreateVector(
        encrypted.wrapped_payload.data(),
        encrypted.wrapped_payload.size());

    uint8_t provider_public_key[KEY_BYTES];
    derive_server_public_key(provider_public_key);
    const auto verifier_public_key = builder.CreateVector(
        provider_public_key,
        sizeof(provider_public_key));
    const auto req_id = builder.CreateString(metadata.req_id);
    const auto module_id = builder.CreateString(metadata.module_id);
    const auto module_version = metadata.module_version.empty()
        ? flatbuffers::Offset<flatbuffers::String>()
        : builder.CreateString(metadata.module_version);
    const auto granted_domain = builder.CreateString(metadata.granted_domain);
    const auto grant_status = builder.CreateString("granted");
    const auto required_scope = builder.CreateString(DEFAULT_REQUIRED_SCOPE);
    const auto root = CreateLGR(
        builder,
        licensingGrantMessageType::Granted,
        req_id,
        module_id,
        module_version,
        0,
        0,
        granted_domain,
        metadata.granted_timeout_ms,
        granted_domain,
        metadata.granted_timeout_ms,
        metadata.expires_at_ms,
        required_scope,
        grant_status,
        0,
        0,
        descriptor_offset,
        wrapped_header,
        wrapped_payload,
        verifier_public_key,
        0);
    FinishLGRBuffer(builder, root);

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

    if (req_len < 8 || !PIVBufferHasIdentifier(req_ptr)) {
        *out_len_ptr = 0;
        return nullptr;
    }
    flatbuffers::Verifier verifier(req_ptr, req_len);
    if (!VerifyPIVBuffer(verifier)) {
        *out_len_ptr = 0;
        return nullptr;
    }
    const PIV* envelope = GetPIV(req_ptr);
    const PIVRequest* req = envelope ? envelope->REQUEST() : nullptr;
    if (!req) {
        *out_len_ptr = 0;
        return nullptr;
    }
    const char* method = req->METHOD_ID() ? req->METHOD_ID()->c_str() : "";

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
