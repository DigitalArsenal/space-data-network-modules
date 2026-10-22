// SDK protected-publication writer. Wire format authority: transport/pki.js and
// transport/records.js; the unchanged client-decrypt rebuilds this ENC as AAD.
#include <cstdint>
#include <cstring>
#include <stdexcept>
#include <string>
#include <vector>
#include <set>
#include <sys/time.h>
#ifdef TIME_UTC
#undef TIME_UTC
#endif
#include <flatbuffers/flatbuffers.h>
#include "ENC_generated.h"
#include "FIL_generated.h"
#include "KMF_generated.h"
#include "REC_generated.h"
#include "ModuleConfig_generated.h"
#include "space_data_module_invoke.h"
#include "plugin_manifest_bytes.h"
#include <cryptopp/aes.h>
#include <cryptopp/gcm.h>
#include <cryptopp/hkdf.h>
#include <cryptopp/sha.h>
#include <cryptopp/xed25519.h>
#include <cryptopp/secblock.h>

extern "C" __attribute__((import_module("wasi_snapshot_preview1"), import_name("random_get")))
int runtime_random_get(void*, size_t);

namespace {
// SecByteBlock wipes secret allocations on normal and exceptional exits. The
// ABI input also contains a key copy; wipe that guest-memory copy before return.
struct WipeInput {
    uint8_t* data; size_t length;
    ~WipeInput() { CryptoPP::SecureWipeBuffer(data, length); }
};
class RuntimeRandom final : public CryptoPP::RandomNumberGenerator {
public:
    void GenerateBlock(CryptoPP::byte* out, size_t length) override {
        if (runtime_random_get(out, length) != 0) {
            CryptoPP::SecureWipeBuffer(out, length);
            throw std::runtime_error("entropy-unavailable");
        }
    }
};
const plugin_input_frame_t* input(const char* port, uint32_t ordinal = 0) {
    const int32_t i = plugin_find_input_index(port, ordinal);
    return i < 0 ? nullptr : plugin_get_input_frame(static_cast<uint32_t>(i));
}
int fail(const char* code, const char* message) {
    plugin_reset_output_state();
    plugin_set_error(code, message);
    return 1;
}
struct EncryptionMetadata {
    std::vector<uint8_t> public_key, nonce;
    std::string context;
    uint64_t timestamp;
};
// JS object-API pack order, including empty vectors, is part of the GCM AAD.
flatbuffers::Offset<ENC> encode_enc(flatbuffers::FlatBufferBuilder& b, const EncryptionMetadata& e) {
    const auto pub = b.CreateVector(e.public_key);
    const auto nonce = b.CreateVector(e.nonce);
    const auto recipient = b.CreateVector(static_cast<const uint8_t*>(nullptr), 0);
    const auto context = b.CreateString(e.context);
    const auto schema = b.CreateVector(static_cast<const uint8_t*>(nullptr), 0);
    ENCBuilder table(b);
    table.add_VERSION(1);
    table.add_KEY_EXCHANGE(KeyExchange::X25519);
    table.add_SYMMETRIC(static_cast<SymmetricAlgo>(1)); // SDK AES-256-GCM wire value
    table.add_KEY_DERIVATION(KDF::HKDF_SHA256);
    table.add_EPHEMERAL_PUBLIC_KEY(pub);
    table.add_NONCE_START(nonce);
    table.add_RECIPIENT_KEY_ID(recipient);
    table.add_CONTEXT(context);
    table.add_SCHEMA_HASH(schema);
    table.add_TIMESTAMP(e.timestamp);
    return table.Finish();
}
std::vector<uint8_t> seal_file(const FIL* file, const CryptoPP::SecByteBlock& recipient_public,
                               const std::string& context, RuntimeRandom& rng) {
    CryptoPP::x25519 exchange;
    CryptoPP::SecByteBlock ephemeral(32), shared(32), aes(32);
    EncryptionMetadata meta{{}, {}, context, 0};
    meta.public_key.resize(32);
    meta.nonce.resize(12);
    exchange.GenerateKeyPair(rng, ephemeral, meta.public_key.data());
    rng.GenerateBlock(meta.nonce.data(), meta.nonce.size());
    if (!exchange.Agree(shared, ephemeral, recipient_public)) throw std::runtime_error("key-agreement-failed");
    CryptoPP::HKDF<CryptoPP::SHA256> hkdf;
    hkdf.DeriveKey(aes, aes.size(), shared, shared.size(), nullptr, 0,
                   reinterpret_cast<const uint8_t*>(context.data()), context.size());
    timeval now{};
    if (gettimeofday(&now, nullptr) != 0) throw std::runtime_error("clock-unavailable");
    meta.timestamp = static_cast<uint64_t>(now.tv_sec) * 1000 + now.tv_usec / 1000;
    flatbuffers::FlatBufferBuilder aad(256);
    aad.Finish(encode_enc(aad, meta), ENCIdentifier());
    const auto* bytes = file->CONTENT();
    const size_t size = bytes->size();
    std::vector<uint8_t> sealed(size + 16);
    CryptoPP::GCM<CryptoPP::AES>::Encryption cipher;
    cipher.SetKeyWithIV(aes, aes.size(), meta.nonce.data(), meta.nonce.size());
    cipher.SpecifyDataLengths(aad.GetSize(), size, 0);
    cipher.Update(aad.GetBufferPointer(), aad.GetSize());
    cipher.ProcessData(sealed.data(), bytes->Data(), size);
    cipher.TruncatedFinal(sealed.data() + size, 16);

    flatbuffers::FlatBufferBuilder trailer(384);
    const auto version = trailer.CreateString("1.0.0");
    const auto enc = encode_enc(trailer, meta);
    const auto standard = trailer.CreateString("ENC");
    // Same object pack field order as the SDK's RecordT and RECT.
    RecordBuilder record(trailer);
    record.add_value_type(RecordType::ENC);
    record.add_value(enc.Union());
    record.add_standard(standard);
    const auto entry = record.Finish();
    const auto records = trailer.CreateVector(&entry, 1);
    RECBuilder collection(trailer);
    collection.add_version(version);
    collection.add_RECORDS(records);
    FinishRECBuffer(trailer, collection.Finish());
    sealed.insert(sealed.end(), trailer.GetBufferPointer(), trailer.GetBufferPointer() + trailer.GetSize());
    const uint32_t length = trailer.GetSize();
    for (unsigned shift = 0; shift < 32; shift += 8) sealed.push_back(static_cast<uint8_t>(length >> shift));
    sealed.insert(sealed.end(), {'$', 'R', 'E', 'C'});
    return sealed;
}
std::vector<uint8_t> file_frame(const std::vector<uint8_t>& bytes) {
    flatbuffers::FlatBufferBuilder b(bytes.size() + 128);
    const auto content = b.CreateVector(bytes);
    FILBuilder f(b);
    f.add_KIND(filEntryKind::File);
    f.add_SIZE(bytes.size());
    f.add_CONTENT(content);
    FinishFILBuffer(b, f.Finish());
    return {b.GetBufferPointer(), b.GetBufferPointer() + b.GetSize()};
}
}
extern "C" void __wasm_call_ctors();
extern "C" {
void _initialize() {
    static bool initialized = false;
    if (!initialized) { initialized = true; __wasm_call_ctors(); }
}
const uint8_t* plugin_get_manifest_flatbuffer() { return publication_seal_plugin_manifest_bytes; }
uint32_t plugin_get_manifest_flatbuffer_size() { return publication_seal_plugin_manifest_bytes_len; }
int seal() {
    plugin_reset_output_state();
    const auto* key_frame = input("release_key");
    const auto* options_frame = input("options");
    if (!key_frame || !options_frame || !input("file")) return fail("missing-input", "file, release_key and options are required.");
    flatbuffers::Verifier key_verifier(key_frame->payload, key_frame->payload_length);
    if (!VerifyKMFBuffer(key_verifier)) return fail("invalid-key", "release_key must be a KMF.");
    const KMF* key = GetKMF(key_frame->payload);
    const auto* key_bytes = key->KEY_BYTES();
    WipeInput wipe{key_bytes ? const_cast<uint8_t*>(key_bytes->Data()) : nullptr, key_bytes ? key_bytes->size() : 0};
    if (!key_bytes || key_bytes->size() != 32 || key->ROLE() != keyMaterialRole::DecryptKey)
        return fail("invalid-key", "release_key requires ROLE DecryptKey and 32 key bytes.");
    flatbuffers::Verifier config_verifier(options_frame->payload, options_frame->payload_length);
    if (!sdn::runtime::VerifyModuleConfigBuffer(config_verifier)) return fail("invalid-options", "options must be a ModuleConfig.");
    const auto* config = sdn::runtime::GetModuleConfig(options_frame->payload);
    std::string context;
    std::vector<std::string> names;
    bool context_seen = false, names_seen = false;
    if (config->ENTRIES()) for (const auto* entry : *config->ENTRIES()) {
        if (!entry->KEY()) return fail("invalid-options", "Config entries need keys.");
        const auto field = entry->KEY()->str();
        if (field == "context" && !context_seen && entry->KIND() == sdn::runtime::configValueKind_String && entry->STRING_VALUE()) {
            context_seen = true; context = entry->STRING_VALUE()->str();
        } else if (field == "names" && !names_seen && entry->KIND() == sdn::runtime::configValueKind_StringList && entry->STRINGS()) {
            names_seen = true;
            for (const auto* name : *entry->STRINGS()) names.push_back(name->str());
        } else return fail("invalid-options", "Expected one context string and one names StringList.");
    }
    if (context.empty() || context.find('\0') != std::string::npos || names.empty())
        return fail("invalid-options", "context and names must be nonempty strings without NUL bytes.");
    std::set<std::string> unique;
    std::vector<const FIL*> files;
    for (uint32_t i = 0; const auto* frame = input("file", i); ++i) {
        flatbuffers::Verifier verifier(frame->payload, frame->payload_length);
        if (!VerifyFILBuffer(verifier)) return fail("invalid-file", "Every file must be a FIL.");
        const auto* file = GetFIL(frame->payload);
        if (!file->CONTENT()) return fail("invalid-file", "Every file needs CONTENT.");
        files.push_back(file);
    }
    if (files.size() != names.size()) return fail("invalid-options", "names must match file count and order.");
    for (const auto& name : names) if (name.empty() || name.find('\0') != std::string::npos || !unique.insert(name).second)
        return fail("invalid-options", "File names must be nonempty, unique and without NUL bytes.");
    try {
        RuntimeRandom rng;
        CryptoPP::SecByteBlock release(key_bytes->Data(), 32), recipient_public(32);
        CryptoPP::x25519 exchange;
        exchange.GeneratePublicKey(rng, release, recipient_public);
        // Stage all outputs before emitting; a late entropy failure never emits a partial batch.
        std::vector<std::vector<uint8_t>> outputs;
        for (size_t i = 0; i < files.size(); ++i)
            outputs.push_back(file_frame(seal_file(files[i], recipient_public, context + "/" + names[i], rng)));
        for (size_t i = 0; i < outputs.size(); ++i) {
            const auto& out = outputs[i];
            if (plugin_push_output_ex("file", "FIL.fbs", "$FIL", PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER,
                                      "FIL", 0, 0, out.data(), out.size()) < 0)
                return fail("emit-failed", "Sealed file output was refused.");
        }
        return 0;
    } catch (const std::exception& e) {
        if (std::strcmp(e.what(), "entropy-unavailable") == 0)
            return fail("entropy-unavailable", "Runtime CSPRNG failed; no files were sealed.");
        return fail("seal-failed", "Publication encryption failed.");
    } catch (...) { return fail("seal-failed", "Publication encryption failed."); }
}
}
