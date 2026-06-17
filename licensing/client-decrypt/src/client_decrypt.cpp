/**
 * SDN Client Decrypt Module (C++ / Crypto++)
 *
 * Decrypts either the legacy JSON envelope format or the canonical SDS `$LGR`
 * module-delivery grant format. For `$LGR` inputs the module fetches the
 * encrypted bundle over IPFS through the sync space_data_module_host bridge when the host has
 * not already supplied the encrypted bundle bytes.
 */

#include <stdint.h>
#include <stddef.h>
#include <string.h>
#include <stdlib.h>

#include <memory>
#include <array>
#include <string>
#include <string_view>
#include <vector>

// Emscripten's sysroot defines TIME_UTC as a macro; SDS generated headers also
// contain fields with that exact name.
#ifdef TIME_UTC
#undef TIME_UTC
#endif

#include <flatbuffers/flatbuffers.h>
#include "ENC_generated.h"
#include "LGR_generated.h"
#include "PIV_generated.h"
#include "REC_generated.h"

#include <cryptopp/aes.h>
#include <cryptopp/gcm.h>
#include <cryptopp/hkdf.h>
#include <cryptopp/modes.h>
#include <cryptopp/sha.h>
#include <cryptopp/xed25519.h>
#include <cryptopp/secblock.h>

static const char WRAP_INFOS[][64] = {
    "orbpro-key-server-artifact-wrap-v1",
    "plugin-key-server-artifact-wrap-v1",
};
static const size_t WRAP_INFO_COUNT = 2;
static const char MODULE_DELIVERY_GRANT_CONTEXT[] = "space-data-network/module-delivery/grant/v1";
static const size_t KEY_BYTES = 32;
static const size_t GCM_IV_BYTES = 12;
static const size_t GCM_TAG_BYTES = 16;
static const size_t CTR_IV_BYTES = 16;
static const uint16_t KMF_KEY_BYTES_FIELD_ID = 4;
static const uint8_t REC_TRAILER_MAGIC[4] = {'$', 'R', 'E', 'C'};
static const size_t REC_TRAILER_FOOTER_BYTES = 8;

#if defined(SDN_WASI_PLUGIN)
#include "../../../common/sdm_hostcall_wire.hpp"
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
#else
static bool fetch_ipfs_bytes(const char*, size_t, std::vector<uint8_t>&) {
    return false;
}
#endif

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
    derive_hkdf_key(master_key, KEY_BYTES, info, 20, out_iv, CTR_IV_BYTES);
}

static void aes_ctr_xor(
    uint8_t* data,
    size_t data_len,
    const uint8_t* key,
    const uint8_t* iv)
{
    CryptoPP::CTR_Mode<CryptoPP::AES>::Encryption ctr;
    ctr.SetKeyWithIV(key, KEY_BYTES, iv, CTR_IV_BYTES);
    ctr.ProcessData(data, data, data_len);
}

// AES-256-GCM is not yet published in the SDS SymmetricAlgo enum (which only
// defines AES_256_CTR = 0); the SDK encodes it as raw byte value 1.
static const uint8_t SYMMETRIC_ALGO_AES_256_GCM = 1;

// Re-encode a parsed ENC record as a standalone `$ENC` FlatBuffer with the
// exact byte layout the SDK's encodeEncRecord() produces (the JS object-API
// pack order). The SDK uses these bytes as the GCM AAD for protected
// publications, so the encoding must be byte-identical: vectors are created
// even when empty (matching the JS pack), strings only when present, and the
// table fields are pushed in ascending field order.
static std::vector<uint8_t> encode_enc_record_for_aad(const ENC* enc) {
    flatbuffers::FlatBufferBuilder fbb(256);
    const auto* eph = enc->EPHEMERAL_PUBLIC_KEY();
    const auto* nonce = enc->NONCE_START();
    const auto* rkid = enc->RECIPIENT_KEY_ID();
    const auto* shash = enc->SCHEMA_HASH();
    const auto eph_offset =
        fbb.CreateVector(eph ? eph->Data() : nullptr, eph ? eph->size() : 0);
    const auto nonce_offset =
        fbb.CreateVector(nonce ? nonce->Data() : nullptr, nonce ? nonce->size() : 0);
    const auto rkid_offset =
        fbb.CreateVector(rkid ? rkid->Data() : nullptr, rkid ? rkid->size() : 0);
    flatbuffers::Offset<flatbuffers::String> context_offset = 0;
    if (enc->CONTEXT()) {
        context_offset = fbb.CreateString(enc->CONTEXT()->c_str(), enc->CONTEXT()->size());
    }
    const auto shash_offset =
        fbb.CreateVector(shash ? shash->Data() : nullptr, shash ? shash->size() : 0);
    flatbuffers::Offset<flatbuffers::String> root_type_offset = 0;
    if (enc->ROOT_TYPE()) {
        root_type_offset = fbb.CreateString(enc->ROOT_TYPE()->c_str(), enc->ROOT_TYPE()->size());
    }

    ENCBuilder table_builder(fbb);
    table_builder.add_VERSION(enc->VERSION());
    table_builder.add_KEY_EXCHANGE(enc->KEY_EXCHANGE());
    table_builder.add_SYMMETRIC(enc->SYMMETRIC());
    table_builder.add_KEY_DERIVATION(enc->KEY_DERIVATION());
    table_builder.add_EPHEMERAL_PUBLIC_KEY(eph_offset);
    table_builder.add_NONCE_START(nonce_offset);
    table_builder.add_RECIPIENT_KEY_ID(rkid_offset);
    table_builder.add_CONTEXT(context_offset);
    table_builder.add_SCHEMA_HASH(shash_offset);
    table_builder.add_ROOT_TYPE(root_type_offset);
    table_builder.add_TIMESTAMP(enc->TIMESTAMP());
    fbb.Finish(table_builder.Finish(), ENCIdentifier());
    return std::vector<uint8_t>(
        fbb.GetBufferPointer(),
        fbb.GetBufferPointer() + fbb.GetSize());
}

static bool record_standard_is(const Record* record, const char* expected) {
    return record && record->standard() &&
        record->standard()->string_view() == std::string_view(expected);
}

static const ENC* record_value_as_enc(const Record* record) {
    const auto* typed = record ? record->value_as_ENC() : nullptr;
    if (typed) {
        return typed;
    }
    return record_standard_is(record, "ENC") && record->value()
        ? static_cast<const ENC*>(record->value())
        : nullptr;
}

static const KMF* record_value_as_kmf(const Record* record) {
    const auto* typed = record ? record->value_as_KMF() : nullptr;
    if (typed) {
        return typed;
    }
    return record_standard_is(record, "KMF") && record->value()
        ? static_cast<const KMF*>(record->value())
        : nullptr;
}

static uint32_t read_u32_le(const uint8_t* bytes) {
    return static_cast<uint32_t>(bytes[0]) |
        (static_cast<uint32_t>(bytes[1]) << 8) |
        (static_cast<uint32_t>(bytes[2]) << 16) |
        (static_cast<uint32_t>(bytes[3]) << 24);
}

static int decrypt_protected_publication_bundle(
    const std::vector<uint8_t>& protected_bundle,
    const uint8_t* recipient_private_key,
    size_t recipient_private_key_len,
    std::vector<uint8_t>& plaintext_out,
    std::string& error_out)
{
    plaintext_out.clear();
    error_out.clear();
    if (protected_bundle.size() < REC_TRAILER_FOOTER_BYTES) {
        return 0;
    }

    const size_t footer_offset = protected_bundle.size() - REC_TRAILER_FOOTER_BYTES;
    const uint8_t* footer = protected_bundle.data() + footer_offset;
    if (memcmp(footer + 4, REC_TRAILER_MAGIC, sizeof(REC_TRAILER_MAGIC)) != 0) {
        return 0;
    }

    const uint32_t record_collection_len = read_u32_le(footer);
    if (record_collection_len == 0 || record_collection_len > footer_offset) {
        error_out = "protected publication REC trailer length is invalid";
        return -1;
    }
    const size_t record_collection_offset =
        footer_offset - static_cast<size_t>(record_collection_len);
    const uint8_t* record_collection =
        protected_bundle.data() + record_collection_offset;

    flatbuffers::Verifier verifier(record_collection, record_collection_len);
    if (!VerifyRECBuffer(verifier)) {
        error_out = "protected publication REC trailer is invalid";
        return -1;
    }

    const REC* rec = GetREC(record_collection);
    if (!rec || !rec->RECORDS() || rec->RECORDS()->size() == 0) {
        error_out = "protected publication REC trailer is empty";
        return -1;
    }

    const ENC* enc = nullptr;
    for (uint32_t index = 0; index < rec->RECORDS()->size(); index++) {
        const auto* record = rec->RECORDS()->Get(index);
        const auto* candidate = record_value_as_enc(record);
        if (candidate) {
            enc = candidate;
            break;
        }
    }
    if (!enc) {
        return 0;
    }

    const auto* ephemeral_public_key = enc->EPHEMERAL_PUBLIC_KEY();
    const auto* nonce_start = enc->NONCE_START();
    if (recipient_private_key_len != KEY_BYTES ||
        !ephemeral_public_key || ephemeral_public_key->size() != KEY_BYTES ||
        !nonce_start || nonce_start->size() != GCM_IV_BYTES) {
        error_out = "protected publication ENC record is missing required bytes";
        return -1;
    }
    const uint8_t symmetric_raw = static_cast<uint8_t>(enc->SYMMETRIC());
    const bool is_gcm = symmetric_raw == SYMMETRIC_ALGO_AES_256_GCM;
    if (enc->KEY_EXCHANGE() != KeyExchange::X25519 ||
        (enc->SYMMETRIC() != SymmetricAlgo::AES_256_CTR && !is_gcm) ||
        enc->KEY_DERIVATION() != KDF::HKDF_SHA256) {
        error_out = "protected publication ENC record uses an unsupported cipher suite";
        return -1;
    }

    CryptoPP::x25519 x25519_scheme;
    CryptoPP::SecByteBlock shared_secret(KEY_BYTES);
    if (!x25519_scheme.Agree(
            shared_secret,
            recipient_private_key,
            ephemeral_public_key->Data())) {
        error_out = "protected publication X25519 key agreement failed";
        return -1;
    }

    const auto* context_string = enc->CONTEXT();
    const uint8_t* context = context_string
        ? reinterpret_cast<const uint8_t*>(context_string->c_str())
        : reinterpret_cast<const uint8_t*>("");
    const size_t context_len = context_string ? context_string->size() : 0;
    std::array<uint8_t, KEY_BYTES> aes_key{};
    derive_hkdf_key(
        shared_secret,
        KEY_BYTES,
        context,
        context_len,
        aes_key.data(),
        aes_key.size());

    if (is_gcm) {
        // SDK protected publication payload = ciphertext || 16-byte GCM tag;
        // the serialized standalone ENC record doubles as the GCM AAD.
        if (record_collection_offset < GCM_TAG_BYTES) {
            memset(aes_key.data(), 0, aes_key.size());
            memset(shared_secret.BytePtr(), 0, shared_secret.size());
            error_out = "protected publication GCM payload is truncated";
            return -1;
        }
        const size_t ciphertext_len = record_collection_offset - GCM_TAG_BYTES;
        const uint8_t* ciphertext = protected_bundle.data();
        const uint8_t* tag = protected_bundle.data() + ciphertext_len;
        const std::vector<uint8_t> aad = encode_enc_record_for_aad(enc);

        plaintext_out.assign(ciphertext_len, 0);
        bool gcm_ok = false;
        try {
            CryptoPP::GCM<CryptoPP::AES>::Decryption dec;
            dec.SetKeyWithIV(
                aes_key.data(),
                aes_key.size(),
                nonce_start->Data(),
                nonce_start->size());
            dec.SpecifyDataLengths(aad.size(), ciphertext_len, 0);
            dec.Update(aad.data(), aad.size());
            dec.ProcessData(plaintext_out.data(), ciphertext, ciphertext_len);
            gcm_ok = dec.TruncatedVerify(tag, GCM_TAG_BYTES);
        } catch (...) {
            gcm_ok = false;
        }
        memset(aes_key.data(), 0, aes_key.size());
        memset(shared_secret.BytePtr(), 0, shared_secret.size());
        if (!gcm_ok) {
            memset(plaintext_out.data(), 0, plaintext_out.size());
            plaintext_out.clear();
            error_out = "protected publication GCM authentication failed";
            return -1;
        }
        return 1;
    }

    std::array<uint8_t, CTR_IV_BYTES> ctr_iv{};
    memcpy(ctr_iv.data(), nonce_start->Data(), nonce_start->size());
    plaintext_out.assign(
        protected_bundle.data(),
        protected_bundle.data() + record_collection_offset);
    aes_ctr_xor(plaintext_out.data(), plaintext_out.size(), aes_key.data(), ctr_iv.data());
    memset(aes_key.data(), 0, aes_key.size());
    memset(shared_secret.BytePtr(), 0, shared_secret.size());
    memset(ctr_iv.data(), 0, ctr_iv.size());
    return 1;
}

static bool unwrap_sds_wrapped_content_key(
    const ENC* wrapped_header,
    const flatbuffers::Vector<uint8_t>* wrapped_payload,
    const uint8_t* requester_private_key,
    std::vector<uint8_t>& content_key_out,
    std::string& error_out)
{
    const auto* ephemeral_public_key =
        wrapped_header ? wrapped_header->EPHEMERAL_PUBLIC_KEY() : nullptr;
    const auto* payload = wrapped_payload;
    if (!ephemeral_public_key || ephemeral_public_key->size() != KEY_BYTES ||
        !payload || payload->size() == 0) {
        error_out = "wrapped SDS content key missing required bytes";
        return false;
    }
    if (wrapped_header->KEY_EXCHANGE() != KeyExchange::X25519 ||
        wrapped_header->SYMMETRIC() != SymmetricAlgo::AES_256_CTR ||
        wrapped_header->KEY_DERIVATION() != KDF::HKDF_SHA256) {
        error_out = "wrapped SDS content key uses an unsupported cipher suite";
        return false;
    }

    CryptoPP::x25519 x25519_scheme;
    CryptoPP::SecByteBlock shared_secret(KEY_BYTES);
    if (!x25519_scheme.Agree(
            shared_secret,
            requester_private_key,
            ephemeral_public_key->Data())) {
        error_out = "X25519 key agreement failed";
        return false;
    }

    std::array<uint8_t, KEY_BYTES> payload_key{};
    const auto* context_string = wrapped_header->CONTEXT();
    const uint8_t* context = context_string
        ? reinterpret_cast<const uint8_t*>(context_string->c_str())
        : reinterpret_cast<const uint8_t*>(MODULE_DELIVERY_GRANT_CONTEXT);
    const size_t context_len = context_string
        ? context_string->size()
        : sizeof(MODULE_DELIVERY_GRANT_CONTEXT) - 1;
    derive_hkdf_key(
        shared_secret,
        KEY_BYTES,
        context,
        context_len,
        payload_key.data(),
        payload_key.size());

    std::vector<uint8_t> rec_payload(payload->begin(), payload->end());
    flatbuffers::Verifier verifier(rec_payload.data(), rec_payload.size());
    if (!VerifyRECBuffer(verifier)) {
        error_out = "wrapped content key REC payload is invalid";
        return false;
    }

    auto* rec = const_cast<REC*>(GetREC(rec_payload.data()));
    if (!rec || !rec->RECORDS() || rec->RECORDS()->size() != 1) {
        error_out = "wrapped content key REC payload is malformed";
        return false;
    }
    const auto* record = rec->RECORDS()->Get(0);
    const auto* kmf = record_value_as_kmf(record);
    auto* key_bytes = kmf
        ? const_cast<::flatbuffers::Vector<uint8_t>*>(kmf->KEY_BYTES())
        : nullptr;
    if (!key_bytes || key_bytes->size() != KEY_BYTES) {
        error_out = "wrapped content key KMF payload is missing key bytes";
        return false;
    }

    std::array<uint8_t, KEY_BYTES> field_key{};
    std::array<uint8_t, CTR_IV_BYTES> field_iv{};
    derive_field_key(payload_key.data(), KMF_KEY_BYTES_FIELD_ID, 0, field_key.data());
    derive_field_iv(payload_key.data(), KMF_KEY_BYTES_FIELD_ID, 0, field_iv.data());
    aes_ctr_xor(key_bytes->Data(), key_bytes->size(), field_key.data(), field_iv.data());

    content_key_out.assign(key_bytes->begin(), key_bytes->end());
    memset(payload_key.data(), 0, payload_key.size());
    memset(field_key.data(), 0, field_key.size());
    memset(field_iv.data(), 0, field_iv.size());
    memset(rec_payload.data(), 0, rec_payload.size());
    return true;
}

static DecryptResult decrypt_lgr_grant(
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
    if (!LGRBufferHasIdentifier(grant_bytes)) {
        result.error = "invalid SDS LGR grant identifier";
        return result;
    }

    flatbuffers::Verifier verifier(grant_bytes, grant_len);
    if (!VerifyLGRBuffer(verifier)) {
        result.error = "invalid SDS LGR grant buffer";
        return result;
    }

    const LGR* grant = GetLGR(grant_bytes);
    const PLG* descriptor = grant ? grant->MODULE_DESCRIPTOR() : nullptr;
    const ENC* wrapped_header = grant ? grant->WRAPPED_CONTENT_KEY_HEADER() : nullptr;
    const auto* wrapped_payload = grant ? grant->WRAPPED_CONTENT_KEY_PAYLOAD() : nullptr;
    if (!grant ||
        grant->MESSAGE_TYPE() != licensingGrantMessageType::Granted ||
        !descriptor ||
        !wrapped_header ||
        !wrapped_payload ||
        !descriptor->WASM_CID()) {
        result.error = "SDS LGR grant missing required fields";
        return result;
    }

    std::vector<uint8_t> encrypted_bundle;
    if (encrypted_bundle_bytes != nullptr && encrypted_bundle_len > 0) {
        encrypted_bundle.assign(
            encrypted_bundle_bytes,
            encrypted_bundle_bytes + encrypted_bundle_len
        );
    } else {
        const auto* cid = descriptor->WASM_CID();
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
        std::vector<uint8_t> content_key(KEY_BYTES);
        std::string unwrap_error;
        if (!unwrap_sds_wrapped_content_key(
                wrapped_header,
                wrapped_payload,
                priv_key,
                content_key,
                unwrap_error)) {
            result.error = unwrap_error;
            return result;
        }

        std::vector<uint8_t> publication_plaintext;
        std::string publication_error;
        const int publication_status = decrypt_protected_publication_bundle(
            encrypted_bundle,
            content_key.data(),
            content_key.size(),
            publication_plaintext,
            publication_error);
        if (publication_status < 0) {
            result.error = publication_error;
            return result;
        }
        if (publication_status > 0) {
            result.plaintext = std::move(publication_plaintext);
            result.ok = true;
            return result;
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

static std::vector<uint8_t> finish_piv_response(
    flatbuffers::FlatBufferBuilder& fbb,
    flatbuffers::Offset<PIVResponse> response
) {
    const auto root = CreatePIV(fbb, 0, response);
    FinishPIVBuffer(fbb, root);
    return std::vector<uint8_t>(
        fbb.GetBufferPointer(),
        fbb.GetBufferPointer() + fbb.GetSize()
    );
}

static std::vector<uint8_t> build_error_response(
    const char* code,
    const char* msg,
    int32_t status_code,
    uint64_t trace_id = 0
) {
    flatbuffers::FlatBufferBuilder fbb(256);
    const auto code_off = fbb.CreateString(code ? code : "invoke-error");
    const auto msg_off = fbb.CreateString(msg ? msg : "client-decrypt failed");
    const auto response = CreatePIVResponse(
        fbb,
        status_code,
        status_code == 404 ? pivStatus::NOT_FOUND : pivStatus::FAILED,
        false,
        0,
        0,
        0,
        code_off,
        msg_off,
        trace_id
    );
    return finish_piv_response(fbb, response);
}

static std::vector<uint8_t> build_bytes_response(
    const uint8_t* data,
    size_t len,
    uint64_t trace_id = 0
) {
    flatbuffers::FlatBufferBuilder fbb(len + 512);
    fbb.ForceVectorAlignment(len, sizeof(uint8_t), 8);
    const auto arena_vec = fbb.CreateVector(data, len);
    const auto frame = CreateTABDirect(
        fbb,
        0,
        static_cast<uint32_t>(len),
        8,
        payloadWireFormat::FLATBUFFER,
        0,
        bufferMutability::IMMUTABLE,
        bufferOwnership::HOST_OWNED,
        0,
        "result"
    );
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
        trace_id
    );
    return finish_piv_response(fbb, response);
}

static bool resolve_piv_frame_payload(
    const TAB* frame,
    const flatbuffers::Vector<uint8_t>* arena,
    const uint8_t** payload,
    size_t* payload_len
) {
    if (!frame || !payload || !payload_len) {
        return false;
    }
    const size_t offset = static_cast<size_t>(frame->OFFSET());
    const size_t size = static_cast<size_t>(frame->SIZE());
    const size_t arena_size = arena ? static_cast<size_t>(arena->size()) : 0;
    if (size > 0 && !arena) {
        return false;
    }
    if (offset > arena_size || size > arena_size - offset) {
        return false;
    }
    *payload = size > 0 ? arena->data() + offset : nullptr;
    *payload_len = size;
    return true;
}

static std::vector<uint8_t> handle_decrypt_artifact(const PIVRequest* req) {
    const auto* frames = req->INPUTS();
    const auto* arena = req->PAYLOAD_ARENA();
    const uint64_t trace_id = req ? req->TRACE_ID() : 0;
    if (!frames || frames->size() < 2 || frames->size() > 3) {
        return build_error_response(
            "invalid-input",
            "decrypt_artifact requires 2 or 3 input frames",
            400,
            trace_id
        );
    }

    const auto* payload_frame = frames->Get(0);
    const auto* key_frame = frames->Get(1);
    const auto* encrypted_bundle_frame = frames->size() > 2 ? frames->Get(2) : nullptr;
    const uint8_t* payload = nullptr;
    size_t payload_len = 0;
    const uint8_t* private_key = nullptr;
    size_t private_key_len = 0;
    const uint8_t* encrypted_bundle = nullptr;
    size_t encrypted_bundle_len = 0;
    if (!resolve_piv_frame_payload(payload_frame, arena, &payload, &payload_len) ||
        !resolve_piv_frame_payload(key_frame, arena, &private_key, &private_key_len) ||
        (encrypted_bundle_frame &&
            !resolve_piv_frame_payload(
                encrypted_bundle_frame,
                arena,
                &encrypted_bundle,
                &encrypted_bundle_len
            ))) {
        return build_error_response(
            "invalid-input",
            "input frame exceeds payload arena",
            400,
            trace_id
        );
    }

    DecryptResult decrypted;
    if (payload_len >= 8 && LGRBufferHasIdentifier(payload)) {
        decrypted = decrypt_lgr_grant(
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
        return build_error_response(
            "decrypt-failed",
            decrypted.error.c_str(),
            1,
            trace_id
        );
    }
    return build_bytes_response(
        decrypted.plaintext.data(),
        decrypted.plaintext.size(),
        trace_id
    );
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
        std::vector<uint8_t> response = build_error_response(
            "invalid-request",
            "Invoke request bytes are empty.",
            400
        );
        if (out_len_ptr) {
            *out_len_ptr = static_cast<uint32_t>(response.size());
        }
        uint8_t* response_ptr = static_cast<uint8_t*>(malloc(response.size()));
        if (!response_ptr) {
            if (out_len_ptr) {
                *out_len_ptr = 0;
            }
            return nullptr;
        }
        memcpy(response_ptr, response.data(), response.size());
        return response_ptr;
    }

    std::vector<uint8_t> response;
    if (req_len < 8 || !PIVBufferHasIdentifier(req_ptr)) {
        response = build_error_response(
            "invalid-request",
            "Invoke request must be an SDS PIV envelope.",
            400
        );
    } else {
        flatbuffers::Verifier verifier(req_ptr, req_len);
        if (!VerifyPIVBuffer(verifier)) {
            response = build_error_response(
                "invalid-request",
                "SDS PIV invoke envelope verification failed.",
                400
            );
        } else {
            const PIV* envelope = GetPIV(req_ptr);
            const PIVRequest* req = envelope ? envelope->REQUEST() : nullptr;
            const uint64_t trace_id = req ? req->TRACE_ID() : 0;
            if (!req) {
                response = build_error_response(
                    "invalid-request",
                    "SDS PIV invoke envelope does not contain a request.",
                    400,
                    trace_id
                );
            } else {
                const char* method = req->METHOD_ID() ? req->METHOD_ID()->c_str() : "";
                if (strcmp(method, "decrypt_artifact") == 0) {
                    response = handle_decrypt_artifact(req);
                } else {
                    response = build_error_response(
                        "unknown-method",
                        "unknown method",
                        404,
                        trace_id
                    );
                }
            }
        }
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
