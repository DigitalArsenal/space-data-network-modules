#ifndef SDN_COMMON_EPM_VERIFY_H
#define SDN_COMMON_EPM_VERIFY_H

// Verify an EPM (Entity Profile) attestation and extract the bound xpub identity.
//
// The EPM is ed25519-signed (over its RFC 8785 JCS signing content) by its first
// Signing key. Verifying that signature, and confirming that signing key equals
// the key the requester already proved control of, binds the secp256k1 xpub
// identity to the authenticated ed25519 signer across curves. ed25519 verification
// is injected (host call in the wasm module; Crypto++ in native tests) so this
// stays isomorphic and dependency-free.

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

struct VerifyResult {
  bool ok = false;
  std::string xpub;     // bound account xpub (the signing key's XPUB) on success
  std::string error;    // reason on failure
};

// Verify the EPM attestation over its JCS signing content using the EPM's first
// Signing/ed25519 key. If `expected_signing_pubkey` is non-null (32 bytes), the
// EPM signing key MUST equal it (binds the EPM to a key the requester proved).
// On success returns ok + the bound xpub.
VerifyResult VerifyEpm(const EpmFields& epm,
                       const uint8_t* signature, std::size_t signature_len,
                       const uint8_t* expected_signing_pubkey,
                       const Ed25519Verify& verify);

}  // namespace sdn::epm

#endif  // SDN_COMMON_EPM_VERIFY_H
