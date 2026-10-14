#ifndef LICENSING_HOSTCALLS_HPP
#define LICENSING_HOSTCALLS_HPP

// The licensing module's host calls, all SDS $PIV invocations through the SDK's typed hostcall (sdm_piv,
// typedHostcall.hpp; implemented in src/licensing_hostcalls.cpp): aligned HostOps records plus raw frames, no JSON.
// Keys never travel in a record or on a port: secrets arrive as raw "secret" frames from secrets.get, by IDs the
// module config names, and the provider's slot keys stay host-side behind keyslot.sign.

#include <cstddef>
#include <cstdint>
#include <string>
#include <string_view>
#include <vector>

namespace licensing_host {

// clock.now -> TimeValue.UNIX_MS (0 when the clock is not granted).
int64_t now_ms();
// random.bytes {LENGTH} -> raw "data".
bool random_bytes(uint8_t* out, size_t len);
// ipfs.add raw "data" -> IpfsResult.CID.
bool ipfs_add(const uint8_t* data, size_t len, std::string* cid_out);
// ipfs.cat {CID} -> raw "data".
bool ipfs_cat(std::string_view cid, std::vector<uint8_t>* out);
// protocol.request {TARGET, PROTOCOL_ID} + raw "payload" -> raw "data".
bool protocol_request(std::string_view target, std::string_view protocol_id, const uint8_t* payload,
                      size_t payload_len, std::vector<uint8_t>* out);
// crypto.ed25519.verify / crypto.secp256k1.verify: raw "data", "signature", "public_key" -> BoolValue.
bool ed25519_verify(const uint8_t* message, size_t message_len, const uint8_t* public_key, size_t public_key_len,
                    const uint8_t* signature, size_t signature_len, bool* valid_out);
bool secp256k1_verify(const uint8_t* message, size_t message_len, const uint8_t* public_key, size_t public_key_len,
                      const uint8_t* signature, size_t signature_len, bool* valid_out);
// crypto.ed25519.publicKeyFromSeed raw "private_key" -> raw "data".
bool ed25519_public_key_from_seed(const uint8_t* seed, size_t seed_len, uint8_t* public_key_out,
                                  size_t public_key_len);
// crypto.ed25519.sign raw "data", "private_key" -> raw "data".
bool ed25519_sign(const uint8_t* message, size_t message_len, const uint8_t* seed, size_t seed_len,
                  uint8_t* signature_out, size_t signature_len);
// keyslot.sign {SLOT_ID, ALGORITHM Ed25519} + raw "payload" -> raw "data" (the signature).
bool keyslot_sign(std::string_view slot_id, const uint8_t* payload, size_t payload_len,
                  std::vector<uint8_t>* signature_out);
// secrets.get {ID} -> raw "secret": exactly `len` bytes, or false. The response's copy is wiped once read.
bool secret(std::string_view id, uint8_t* out, size_t len);
// plugin.getConfig: the string config `key` names (empty when absent or when the call fails, with *error set).
std::string config_string(const char* key, std::string* error);
// plugin.getConfig content_keys: [{key_id, secret_id, algorithm}] - the entry for `key_id`.
bool content_key_entry(std::string_view key_id, std::string* secret_id, std::string* algorithm, std::string* error);

}  // namespace licensing_host

#endif  // LICENSING_HOSTCALLS_HPP
