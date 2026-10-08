#include "epm_fb.h"

#include <flatbuffers/flatbuffers.h>

#ifdef DOMAIN
#undef DOMAIN
#endif
#include "EPM_generated.h"

namespace sdn::epm {
namespace {

std::string Str(const flatbuffers::String* s) { return s ? s->str() : std::string(); }

}  // namespace

bool EpmFieldsFromBytes(const uint8_t* bytes, std::size_t len, EpmFields* out,
                        std::string* signature_hex) {
  if (bytes == nullptr || len == 0) return false;

  const ::EPM* epm = nullptr;
  if (SizePrefixedEPMBufferHasIdentifier(bytes)) {
    flatbuffers::Verifier verifier(bytes, len);
    if (!VerifySizePrefixedEPMBuffer(verifier)) return false;
    epm = GetSizePrefixedEPM(bytes);
  } else if (EPMBufferHasIdentifier(bytes)) {
    flatbuffers::Verifier verifier(bytes, len);
    if (!VerifyEPMBuffer(verifier)) return false;
    epm = GetEPM(bytes);
  } else {
    return false;
  }
  if (epm == nullptr) return false;

  EpmFields f;
  f.dn = Str(epm->DN());
  f.legal_name = Str(epm->LEGAL_NAME());
  f.family_name = Str(epm->FAMILY_NAME());
  f.given_name = Str(epm->GIVEN_NAME());
  f.additional_name = Str(epm->ADDITIONAL_NAME());
  f.honorific_prefix = Str(epm->HONORIFIC_PREFIX());
  f.honorific_suffix = Str(epm->HONORIFIC_SUFFIX());
  f.job_title = Str(epm->JOB_TITLE());
  f.occupation = Str(epm->OCCUPATION());
  f.email = Str(epm->EMAIL());
  f.telephone = Str(epm->TELEPHONE());
  f.photo = Str(epm->PHOTO());

  if (const ::Address* a = epm->ADDRESS()) {
    f.address.country = Str(a->COUNTRY());
    f.address.region = Str(a->REGION());
    f.address.locality = Str(a->LOCALITY());
    f.address.postal_code = Str(a->POSTAL_CODE());
    f.address.street = Str(a->STREET());
    f.address.post_office_box_number = Str(a->POST_OFFICE_BOX_NUMBER());
  }

  if (const auto* names = epm->ALTERNATE_NAMES()) {
    for (const flatbuffers::String* s : *names) f.alternate_names.push_back(Str(s));
  }

  if (const auto* keys = epm->KEYS()) {
    for (const ::CryptoKey* k : *keys) {
      if (k == nullptr) continue;
      CryptoKey ck;
      ck.public_key = Str(k->PUBLIC_KEY());
      ck.xpub = Str(k->XPUB());
      ck.address_type = Str(k->ADDRESS_TYPE());
      ck.key_address = Str(k->KEY_ADDRESS());
      ck.key_type = EnumNameKeyType(k->KEY_TYPE());  // "Signing" | "Encryption"
      ck.key_path = Str(k->KEY_PATH());
      ck.algorithm = Str(k->ALGORITHM());
      ck.encoding = Str(k->ENCODING());
      f.keys.push_back(std::move(ck));
    }
  }

  if (const auto* multis = epm->MULTIFORMAT_ADDRESS()) {
    for (const flatbuffers::String* s : *multis) f.multiformat_address.push_back(Str(s));
  }

  f.entity_type = EnumNameEntityType(epm->ENTITY_TYPE());  // "User" | "Node"
  f.signature_timestamp = epm->SIGNATURE_TIMESTAMP();
  f.signature_algorithm = Str(epm->SIGNATURE_ALGORITHM());

  if (const auto* proofs = epm->CHAIN_PROOFS()) {
    for (const ::ChainProof* p : *proofs) {
      if (p == nullptr) continue;
      ChainProof cp;
      cp.chain = Str(p->CHAIN());
      cp.address = Str(p->ADDRESS());
      cp.public_key = Str(p->PUBLIC_KEY());
      cp.key_path = Str(p->KEY_PATH());
      cp.signature = Str(p->SIGNATURE());
      cp.signed_payload = Str(p->SIGNED_PAYLOAD());
      cp.algorithm = Str(p->ALGORITHM());
      cp.encoding = Str(p->ENCODING());
      f.chain_proofs.push_back(std::move(cp));
    }
  }

  *out = std::move(f);
  if (signature_hex != nullptr) *signature_hex = Str(epm->SIGNATURE());
  return true;
}

}  // namespace sdn::epm
