#ifndef SDN_COMMON_EPM_VERIFY_H
#define SDN_COMMON_EPM_VERIFY_H

// Verify an EPM attestation, then extract exactly one separately declared
// canonical secp256k1 account xpub bound by that signature.
//
// The EPM is signed (over its RFC 8785 JCS signing content) by one of its Signing
// keys. The signing key's ALGORITHM selects the scheme: empty/"ed25519" ->
// ed25519 over the canonical content (64-byte signature); "secp256k1" -> ECDSA-DER
// over sha256(canonical content) (variable-length DER signature). For the ed25519
// case, confirming that signing key equals the key the requester already proved
// control of binds the separate secp256k1 account xpub entry to the authenticated
// ed25519 signer across curves. Both verifications are injected (host calls in the
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
  std::string xpub;     // separately declared canonical account xpub on success
  std::string error;    // reason on failure
};

// Verify the EPM attestation over its JCS signing content, dispatching on the
// signing key's ALGORITHM. Signing keys are tried in order with ed25519 keys
// first (preserving the 25519 default) and accepted if any verifies. For an
// ed25519 signing key, when `expected_signing_pubkey` is non-null (32 bytes) the
// key MUST equal it. When that binding is requested, a secp256k1 signature may
// not substitute for the proven Ed25519 key. After signature verification,
// exactly one key with ALGORITHM=secp256k1, an account-root KEY_PATH, and XPUB
// must exist; its xpub is bound cross-curve by the verified EPM signature.
VerifyResult VerifyEpm(const EpmFields& epm,
                       const uint8_t* signature, std::size_t signature_len,
                       const uint8_t* expected_signing_pubkey,
                       const Ed25519Verify& verify,
                       const Secp256k1Verify& verify_secp256k1 = {});

}  // namespace sdn::epm

#endif  // SDN_COMMON_EPM_VERIFY_H
