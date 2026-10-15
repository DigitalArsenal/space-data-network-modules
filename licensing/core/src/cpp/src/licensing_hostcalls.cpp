// The licensing module's host calls: SDS $PIV invocations through the SDK's typed hostcall (sdm_piv,
// typedHostcall.hpp). This translation unit is the only one that includes the SDK's typed runtime: its PIV / TAB
// headers are the SDK's unscoped-enum build of the same tables the module's SDS headers (generated/sds, scoped enums)
// declare, so the two never meet in one translation unit.

#include "licensing_hostcalls.hpp"

#include "typedHostcall.hpp"

namespace licensing_host {

namespace ops = sdn::runtime::Aligned;

namespace {

void assign(std::string_view frame, std::vector<uint8_t>* out) {
  out->assign(reinterpret_cast<const uint8_t*>(frame.data()),
              reinterpret_cast<const uint8_t*>(frame.data()) + frame.size());
}

// Wipe a response's raw frames that carried key material.
void wipe(std::string_view frame) {
  if (!frame.empty()) {
    volatile char* p = const_cast<volatile char*>(frame.data());
    for (size_t i = 0; i < frame.size(); ++i) p[i] = 0;
  }
}

// crypto.<curve>.verify raw "data", "signature", "public_key" -> BoolValue.
bool verify(const char* op, ops::cryptoAlgorithm algorithm,
                   const uint8_t* message, size_t message_len,
                   const uint8_t* public_key, size_t public_key_len,
                   const uint8_t* signature, size_t signature_len, bool* valid_out) {
  if (!valid_out) return false;
  ops::CryptoParams p{};
  p.ALGORITHM = algorithm;
  const auto r = sdm_piv::call(op, "CryptoParams", p,
                               {sdm_piv::raw("data", message, message_len),
                                sdm_piv::raw("signature", signature, signature_len),
                                sdm_piv::raw("public_key", public_key, public_key_len)});
  const auto* result = r.result<ops::BoolValue>();
  if (!result) return false;
  *valid_out = result->VALUE;
  return true;
}

}  // namespace

// clock.now -> TimeValue.UNIX_MS (0 when the clock is not granted).
int64_t now_ms() {
  const auto r = sdm_piv::call("clock.now");
  const auto* t = r.result<ops::TimeValue>();
  return t ? static_cast<int64_t>(t->UNIX_MS) : 0;
}

// random.bytes {LENGTH} -> raw "data".
bool random_bytes(uint8_t* out, size_t len) {
  if (len == 0) return true;
  if (!out) return false;
  ops::RandomBytesParams p{};
  p.LENGTH = static_cast<uint32_t>(len);
  const auto r = sdm_piv::call("random.bytes", "RandomBytesParams", p);
  const std::string_view data = r.raw("data");
  const bool ok = data.size() == len;
  if (ok) std::memcpy(out, data.data(), len);
  wipe(data);
  return ok;
}

// ipfs.add raw "data" -> IpfsResult.CID.
bool ipfs_add(const uint8_t* data, size_t len, std::string* cid_out) {
  if (!cid_out) return false;
  ops::IpfsParams p{};
  const auto r = sdm_piv::call("ipfs.add", "IpfsParams", p, {sdm_piv::raw("data", data, len)});
  const auto* result = r.result<ops::IpfsResult>();
  if (!result) return false;
  *cid_out = result->CID.str();
  return !cid_out->empty();
}

// ipfs.cat {CID} -> raw "data".
bool ipfs_cat(std::string_view cid, std::vector<uint8_t>* out) {
  if (!out) return false;
  ops::IpfsParams p{};
  if (!sdm_piv::put(p.CID, cid)) return false;
  p.set_has_CID(true);
  const auto r = sdm_piv::call("ipfs.cat", "IpfsParams", p);
  if (!r.ok()) return false;
  assign(r.raw("data"), out);
  return true;
}

// protocol.request {TARGET, PROTOCOL_ID} + raw "payload" -> raw "data".
bool protocol_request(std::string_view target, std::string_view protocol_id,
                             const uint8_t* payload, size_t payload_len,
                             std::vector<uint8_t>* out) {
  if (!out) return false;
  ops::ProtocolParams p{};
  if (!sdm_piv::put(p.TARGET, target) || !sdm_piv::put(p.PROTOCOL_ID, protocol_id)) return false;
  p.set_has_TARGET(!target.empty());
  p.set_has_PROTOCOL_ID(true);
  const auto r = sdm_piv::call("protocol.request", "ProtocolParams", p,
                               {sdm_piv::raw("payload", payload, payload_len)});
  if (!r.ok()) return false;
  assign(r.raw("data"), out);
  return true;
}

bool ed25519_verify(const uint8_t* message, size_t message_len,
                           const uint8_t* public_key, size_t public_key_len,
                           const uint8_t* signature, size_t signature_len, bool* valid_out) {
  return verify("crypto.ed25519.verify", ops::cryptoAlgorithm_Ed25519, message, message_len,
                public_key, public_key_len, signature, signature_len, valid_out);
}

bool secp256k1_verify(const uint8_t* message, size_t message_len,
                             const uint8_t* public_key, size_t public_key_len,
                             const uint8_t* signature, size_t signature_len, bool* valid_out) {
  return verify("crypto.secp256k1.verify", ops::cryptoAlgorithm_Secp256k1, message, message_len,
                public_key, public_key_len, signature, signature_len, valid_out);
}

// crypto.ed25519.publicKeyFromSeed raw "private_key" -> raw "data".
bool ed25519_public_key_from_seed(const uint8_t* seed, size_t seed_len,
                                         uint8_t* public_key_out, size_t public_key_len) {
  ops::CryptoParams p{};
  p.ALGORITHM = ops::cryptoAlgorithm_Ed25519;
  const auto r = sdm_piv::call("crypto.ed25519.publicKeyFromSeed", "CryptoParams", p,
                               {sdm_piv::raw("private_key", seed, seed_len)});
  const std::string_view data = r.raw("data");
  if (data.size() != public_key_len) return false;
  std::memcpy(public_key_out, data.data(), public_key_len);
  return true;
}

// crypto.ed25519.sign raw "data", "private_key" -> raw "data".
bool ed25519_sign(const uint8_t* message, size_t message_len,
                         const uint8_t* seed, size_t seed_len,
                         uint8_t* signature_out, size_t signature_len) {
  ops::CryptoParams p{};
  p.ALGORITHM = ops::cryptoAlgorithm_Ed25519;
  const auto r = sdm_piv::call("crypto.ed25519.sign", "CryptoParams", p,
                               {sdm_piv::raw("data", message, message_len),
                                sdm_piv::raw("private_key", seed, seed_len)});
  const std::string_view data = r.raw("data");
  if (data.size() != signature_len) return false;
  std::memcpy(signature_out, data.data(), signature_len);
  return true;
}

// keyslot.sign {SLOT_ID, ALGORITHM Ed25519} + raw "payload" -> raw "data" (the
// signature). The slot's private key never enters guest memory.
bool keyslot_sign(std::string_view slot_id, const uint8_t* payload, size_t payload_len,
                         std::vector<uint8_t>* signature_out) {
  if (!signature_out) return false;
  ops::KeyslotParams p{};
  if (slot_id.empty() || !sdm_piv::put(p.SLOT_ID, slot_id)) return false;
  p.set_has_SLOT_ID(true);
  p.ALGORITHM = ops::cryptoAlgorithm_Ed25519;
  const auto r = sdm_piv::call("keyslot.sign", "KeyslotParams", p,
                               {sdm_piv::raw("payload", payload, payload_len)});
  if (!r.ok()) return false;
  assign(r.raw("data"), signature_out);
  return !signature_out->empty();
}

// secrets.get {ID} -> raw "secret": exactly `len` bytes of key material, or false.
// The response's copy is wiped once read.
bool secret(std::string_view id, uint8_t* out, size_t len) {
  if (id.empty() || !out) return false;
  ops::SecretParams p{};
  if (!sdm_piv::put(p.ID, id)) return false;
  p.set_has_ID(true);
  const auto r = sdm_piv::call("secrets.get", "SecretParams", p);
  const std::string_view secret = r.raw("secret");
  const bool ok = secret.size() == len;
  if (ok) std::memcpy(out, secret.data(), len);
  wipe(secret);
  return ok;
}


// plugin.getConfig: the string config `key` names (empty when absent or when the call fails, with *error set).
std::string config_string(const char* key, std::string* error) {
  const sdm_piv::Config config = sdm_piv::get_config();
  if (!config.ok()) {
    if (error) *error = "plugin.getConfig failed: " + config.error_message();
    return {};
  }
  return std::string(config.string(key));
}

// plugin.getConfig content_keys: [{key_id, secret_id, algorithm}] - the entry for `key_id`.
bool content_key_entry(std::string_view key_id, std::string* secret_id, std::string* algorithm, std::string* error) {
  const sdm_piv::Config config = sdm_piv::get_config();
  if (!config.ok()) {
    if (error) *error = "plugin.getConfig failed: " + config.error_message();
    return false;
  }
  const size_t entries = config.count("content_keys");
  for (size_t i = 0; i < entries; ++i) {
    const sdm_piv::ConfigTable entry = config.table("content_keys", i);
    if (entry.string("key_id") != key_id) continue;
    *secret_id = std::string(entry.string("secret_id"));
    *algorithm = std::string(entry.string("algorithm", "aes-256-gcm"));
    return !secret_id->empty();
  }
  if (error) *error = "config content_keys names no secret for this KEY_ID";
  return false;
}

}  // namespace licensing_host
