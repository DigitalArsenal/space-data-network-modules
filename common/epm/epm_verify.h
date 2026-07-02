#ifndef SDN_COMMON_EPM_VERIFY_H
#define SDN_COMMON_EPM_VERIFY_H

// Verify an EPM (Entity Profile) attestation and extract the bound xpub identity.
//
// The EPM is signed (over its RFC 8785 JCS signing content) by one of its Signing
// keys. The signing key's ADDRESS_TYPE selects the scheme: empty/"ed25519" ->
// ed25519 over the canonical content (64-byte signature); "secp256k1" -> ECDSA-DER
// over sha256(canonical content) (variable-length DER signature). For the ed25519
// case, confirming that signing key equals the key the requester already proved
// control of binds the secp256k1 xpub identity to the authenticated ed25519 signer
// across curves; a secp256k1-signed EPM instead self-attests its xpub and is bound
// downstream by the xpub gate. Both verifications are injected (host calls in the
// wasm module; Crypto++ in native tests) so this stays isomorphic and
// dependency-free.

#include <cstddef>
#include <cstdint>
#include <functional>
#include <string>

#include "epm_content.h"

namespace sdn::epm {

// (msg, msg_len, sig, sig_len, pubkey[32]) -> valid?
using Ed25519Verify = std::function<bool(const uint8_t*, std::size_t,
                                         const uint8_t*, std::size_t,
                                         const uint8_t*)>;

// (msg, msg_len, sig_der, sig_len, pubkey, pubkey_len) -> valid?
// The signature is ECDSA-DER; the injected callback (host call) hashes the message
// with sha256 and DER-verifies internally, exactly mirroring the ed25519 callback's
// "verify over the canonical content" contract. pubkey is the SEC1 point (33-byte
// compressed or 65-byte uncompressed).
using Secp256k1Verify = std::function<bool(const uint8_t*, std::size_t,
                                           const uint8_t*, std::size_t,
                                           const uint8_t*, std::size_t)>;

struct VerifyResult {
  bool ok = false;
  std::string xpub;     // bound account xpub (the signing key's XPUB) on success
  std::string error;    // reason on failure
};

// Verify the EPM attestation over its JCS signing content, dispatching on the
// signing key's ADDRESS_TYPE. Signing keys are tried in order with ed25519 keys
// first (preserving the 25519 default) and accepted if any verifies. For an
// ed25519 signing key, when `expected_signing_pubkey` is non-null (32 bytes) the
// key MUST equal it (binds the EPM to a key the requester proved); this cross-curve
// binding does not apply to secp256k1 keys. On success returns ok + the bound xpub
// from the key that verified. `verify_secp256k1` may be empty when only ed25519 is
// supported (secp256k1 signing keys are then skipped).
VerifyResult VerifyEpm(const EpmFields& epm,
                       const uint8_t* signature, std::size_t signature_len,
                       const uint8_t* expected_signing_pubkey,
                       const Ed25519Verify& verify,
                       const Secp256k1Verify& verify_secp256k1 = {});

}  // namespace sdn::epm

#endif  // SDN_COMMON_EPM_VERIFY_H
