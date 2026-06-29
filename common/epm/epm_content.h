#ifndef SDN_COMMON_EPM_CONTENT_H
#define SDN_COMMON_EPM_CONTENT_H

// EPM (Entity Profile) attestation signing content, built as an RFC 8785 JCS
// canonical document. This is the byte sequence the wallet signs (ed25519, first
// signing key) and the in-wasm verifier checks — identical in browser and on
// wasmedge. Mirrors the field set of the Go reference
// (sdn-server/internal/epm/signature.go canonicalSigningContentFromEPM), which is
// being retired in favor of this single isomorphic implementation.
//
// String fields are trimmed and omitted when empty (Go addBytesString semantics).

#include <cstdint>
#include <string>
#include <vector>

#include "../jcs/jcs.h"

namespace sdn::epm {

struct CryptoKey {
  std::string public_key;
  std::string xpub;
  std::string address_type;
  std::string key_address;
  std::string key_type;  // "Signing" | "Encryption" | "" (omitted)
};

struct ChainProof {
  std::string chain;
  std::string address;
  std::string public_key;
  std::string key_path;
  std::string signature;
  std::string signed_payload;
  std::string algorithm;
  std::string encoding;
};

struct Address {
  std::string country;
  std::string region;
  std::string locality;
  std::string postal_code;
  std::string street;
  std::string post_office_box_number;
};

struct EpmFields {
  std::string dn;
  std::string legal_name;
  std::string family_name;
  std::string given_name;
  std::string additional_name;
  std::string honorific_prefix;
  std::string honorific_suffix;
  std::string job_title;
  std::string occupation;
  std::string email;
  std::string telephone;
  Address address;
  std::vector<std::string> alternate_names;
  std::vector<CryptoKey> keys;
  std::vector<std::string> multiformat_address;
  std::string entity_type;  // ENTITY_TYPE enum name; always included
  int64_t signature_timestamp = 0;  // included only when non-zero
  std::vector<ChainProof> chain_proofs;
};

// Build the EPM signing content as a JsonValue (matching the Go field set/rules).
jcs::JsonValue BuildSigningContent(const EpmFields& epm);

// Convenience: the canonical (RFC 8785 JCS) signing bytes for `epm`.
std::string SigningContentBytes(const EpmFields& epm);

}  // namespace sdn::epm

#endif  // SDN_COMMON_EPM_CONTENT_H
