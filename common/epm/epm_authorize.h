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

// The allowlist entry that admits any account: a module whose ALLOWED_XPUBS
// holds "*" is leased to every requester that proves an account (steps 1-4 and
// the account key's proof below), each grant encrypted to that requester's own
// session key. Explicit xpubs beside it change nothing: "*" admits any account.
inline constexpr const char* kAnyAccountXpub = "*";

// Module allowlist membership, the one rule both the challenge-time filter and
// the proof-time gate apply: an empty list gates nothing; otherwise `xpub` must
// be listed, or the list must hold kAnyAccountXpub and `xpub` must name an
// account (non-empty).
bool XpubAllowed(const std::vector<std::string>& allowed_xpubs, const std::string& xpub);

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
//     must pass XpubAllowed (empty list = no allowlist gate). Under ["*"] the
//     key proof and steps 1-4 are still required; only the listing is waived.
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
