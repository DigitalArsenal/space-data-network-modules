#ifndef SDN_COMMON_EPM_KEY_PROOF_H
#define SDN_COMMON_EPM_KEY_PROOF_H

// Proof that the holder of an account xpub authorised a session signing key.
//
// The EPM's Ed25519 signature only shows that the session key ASSERTS an xpub;
// anyone can copy an xpub. For an allowlisted module the requester must also
// carry a ChainProof made by the account key itself (the secp256k1 key the xpub
// encodes) over this canonical statement, LF-terminated, byte-replayed:
//
//   sdn-module-delivery-key/1
//   ed25519:<64 hex, the session signing public key>
//   xpub:<the account xpub>
//   origin:<the web origin that asked, for the wallet's record>
//   expires:<unix seconds>
//
// with ChainProof.KEY_PATH equal to the account key's path, PUBLIC_KEY the
// compressed account public key (hex), ALGORITHM "secp256k1", ENCODING "der",
// SIGNED_PAYLOAD the statement (hex) and SIGNATURE ECDSA-DER over
// sha256(statement) (hex).

#include <cstddef>
#include <cstdint>
#include <string>

#include "epm_content.h"
#include "epm_verify.h"

namespace sdn::epm {

// Empty on success, else the reason. `xpub` is the EPM's verified account xpub,
// `account_key_path` its KEY_PATH, `proven_ed25519` the 32-byte key the requester
// proved control of. Statements valid for longer than 31 days are refused.
std::string VerifySessionKeyProof(const EpmFields& epm,
                                  const std::string& xpub,
                                  const std::string& account_key_path,
                                  const uint8_t* proven_ed25519,
                                  int64_t now_unix,
                                  const Secp256k1Verify& verify_secp256k1);

}  // namespace sdn::epm

#endif  // SDN_COMMON_EPM_KEY_PROOF_H
