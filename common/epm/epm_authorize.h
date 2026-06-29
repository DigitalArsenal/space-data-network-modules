#ifndef SDN_COMMON_EPM_AUTHORIZE_H
#define SDN_COMMON_EPM_AUTHORIZE_H

// Module-delivery authorization decision (the gate), built from the verified
// pieces. Given a re-sent $EPM FlatBuffer + the signing key the requester already
// proved control of + the module's xpub allowlist, decide allow/deny and return
// the authorized xpub. Pure + isomorphic (ed25519 verify injected).

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
//  2. verify the ed25519 attestation, bound to `proven_signing_pubkey` (32 bytes;
//     null skips the binding — not recommended for the live gate),
//  3. freshness: when `max_age_seconds > 0`, require
//     |now_unix - SIGNATURE_TIMESTAMP| <= max_age_seconds (the EPM is re-sent per
//     grant, so a stale one is rejected),
//  4. membership: when `allowed_xpubs` is non-empty, the bound xpub must be in it
//     (empty list = no allowlist gate).
AuthorizeResult AuthorizeModuleRequest(const uint8_t* epm_bytes, std::size_t epm_len,
                                       const uint8_t* proven_signing_pubkey,
                                       const std::vector<std::string>& allowed_xpubs,
                                       int64_t now_unix, int64_t max_age_seconds,
                                       const Ed25519Verify& verify);

}  // namespace sdn::epm

#endif  // SDN_COMMON_EPM_AUTHORIZE_H
