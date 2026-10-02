#ifndef SDN_COMMON_EPM_AUTHORIZE_H
#define SDN_COMMON_EPM_AUTHORIZE_H

// Module-delivery authorization decision (the gate), built from the verified
// pieces. Given a re-sent $EPM FlatBuffer + the signing key the requester already
// proved control of + the module's xpub allowlist, decide allow/deny and return
// the authorized xpub. Pure + isomorphic (ed25519 + secp256k1 verify injected).

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

#include "epm_verify.h"

namespace sdn::epm {

struct AuthorizeResult {
  bool ok = false;
  std::string xpub;   // authorized account xpub on success
  std::string error;  // reason on failure
};

// Steps:
//  1. parse the $EPM FlatBuffer,
//  2. verify the attestation per CryptoKey.ALGORITHM. The live gate supplies
//     `proven_signing_pubkey`, requiring the EPM's Ed25519 signer to be the key
//     already proved through LPF,
//  3. select exactly one separate canonical secp256k1 account-xpub entry. The
//     verified Ed25519 signature over the complete EPM binds it cross-curve,
//  4. freshness: when `max_age_seconds > 0`, require
//     |now_unix - SIGNATURE_TIMESTAMP| <= max_age_seconds (the EPM is re-sent per
//     grant, so a stale one is rejected),
//  5. membership: when `allowed_xpubs` is non-empty, the account key must have
//     authorised the proven session key (epm_key_proof.h) and the bound xpub
//     must be in the list (empty list = no allowlist gate).
// `verify_secp256k1` may be empty when only ed25519 identities are supported.
AuthorizeResult AuthorizeModuleRequest(const uint8_t* epm_bytes, std::size_t epm_len,
                                       const uint8_t* proven_signing_pubkey,
                                       const std::vector<std::string>& allowed_xpubs,
                                       int64_t now_unix, int64_t max_age_seconds,
                                       const Ed25519Verify& verify,
                                       const Secp256k1Verify& verify_secp256k1 = {},
                                       const std::string& requested_domain = std::string());

}  // namespace sdn::epm

#endif  // SDN_COMMON_EPM_AUTHORIZE_H
