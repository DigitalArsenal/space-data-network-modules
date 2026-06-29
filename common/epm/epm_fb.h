#ifndef SDN_COMMON_EPM_FB_H
#define SDN_COMMON_EPM_FB_H

// Map a (size-prefixed) $EPM FlatBuffer — the latest spacedatastandards.org EPM
// schema (v1.0.3) — into EpmFields signing content + the embedded SIGNATURE hex.
// This is the only schema-aware bridge; everything downstream (JCS canonicalize,
// ed25519 verify) is pure and isomorphic.
//
// Requires the generated EPM_generated.h (the module's generated/sds include path)
// and flatbuffers on the include path.

#include <cstddef>
#include <cstdint>
#include <string>

#include "epm_content.h"

namespace sdn::epm {

// Returns false if the buffer lacks the $EPM identifier or fails verification.
bool EpmFieldsFromBytes(const uint8_t* bytes, std::size_t len, EpmFields* out,
                        std::string* signature_hex);

}  // namespace sdn::epm

#endif  // SDN_COMMON_EPM_FB_H
