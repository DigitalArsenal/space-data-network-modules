#include "epm_content.h"

namespace sdn::epm {
namespace {

using jcs::JsonValue;

std::string TrimSpace(const std::string& s) {
  size_t b = 0;
  size_t e = s.size();
  const auto is_ws = [](unsigned char c) {
    return c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\v' || c == '\f';
  };
  while (b < e && is_ws(static_cast<unsigned char>(s[b]))) ++b;
  while (e > b && is_ws(static_cast<unsigned char>(s[e - 1]))) --e;
  return s.substr(b, e - b);
}

// Go addBytesString: trim, omit if empty.
void AddStr(JsonValue* obj, const char* key, const std::string& value) {
  const std::string trimmed = TrimSpace(value);
  if (!trimmed.empty()) obj->object.emplace_back(key, JsonValue::Str(trimmed));
}

// Trimmed non-empty strings -> array; attach under `key` if non-empty.
void AddStrArray(JsonValue* obj, const char* key, const std::vector<std::string>& values) {
  JsonValue arr = JsonValue::Arr();
  for (const auto& v : values) {
    const std::string trimmed = TrimSpace(v);
    if (!trimmed.empty()) arr.array.push_back(JsonValue::Str(trimmed));
  }
  if (!arr.array.empty()) obj->object.emplace_back(key, std::move(arr));
}

}  // namespace

JsonValue BuildSigningContent(const EpmFields& epm) {
  JsonValue content = JsonValue::Obj();

  AddStr(&content, "DN", epm.dn);
  AddStr(&content, "LEGAL_NAME", epm.legal_name);
  AddStr(&content, "FAMILY_NAME", epm.family_name);
  AddStr(&content, "GIVEN_NAME", epm.given_name);
  AddStr(&content, "ADDITIONAL_NAME", epm.additional_name);
  AddStr(&content, "HONORIFIC_PREFIX", epm.honorific_prefix);
  AddStr(&content, "HONORIFIC_SUFFIX", epm.honorific_suffix);
  AddStr(&content, "JOB_TITLE", epm.job_title);
  AddStr(&content, "OCCUPATION", epm.occupation);
  AddStr(&content, "EMAIL", epm.email);
  AddStr(&content, "TELEPHONE", epm.telephone);

  {
    JsonValue address = JsonValue::Obj();
    AddStr(&address, "COUNTRY", epm.address.country);
    AddStr(&address, "REGION", epm.address.region);
    AddStr(&address, "LOCALITY", epm.address.locality);
    AddStr(&address, "POSTAL_CODE", epm.address.postal_code);
    AddStr(&address, "STREET", epm.address.street);
    AddStr(&address, "POST_OFFICE_BOX_NUMBER", epm.address.post_office_box_number);
    if (!address.object.empty()) content.object.emplace_back("ADDRESS", std::move(address));
  }

  AddStrArray(&content, "ALTERNATE_NAMES", epm.alternate_names);

  {
    JsonValue keys = JsonValue::Arr();
    for (const auto& k : epm.keys) {
      JsonValue entry = JsonValue::Obj();
      AddStr(&entry, "PUBLIC_KEY", k.public_key);
      AddStr(&entry, "XPUB", k.xpub);
      AddStr(&entry, "ADDRESS_TYPE", k.address_type);
      AddStr(&entry, "KEY_ADDRESS", k.key_address);
      // KEY_TYPE is an enum label ("Signing"/"Encryption"), added verbatim (not trimmed).
      if (k.key_type == "Signing" || k.key_type == "Encryption") {
        entry.object.emplace_back("KEY_TYPE", JsonValue::Str(k.key_type));
      }
      AddStr(&entry, "KEY_PATH", k.key_path);
      AddStr(&entry, "ALGORITHM", k.algorithm);
      AddStr(&entry, "ENCODING", k.encoding);
      if (!entry.object.empty()) keys.array.push_back(std::move(entry));
    }
    if (!keys.array.empty()) content.object.emplace_back("KEYS", std::move(keys));
  }

  AddStrArray(&content, "MULTIFORMAT_ADDRESS", epm.multiformat_address);

  content.object.emplace_back("ENTITY_TYPE", JsonValue::Str(epm.entity_type));

  if (epm.signature_timestamp != 0) {
    content.object.emplace_back("SIGNATURE_TIMESTAMP", JsonValue::Int(epm.signature_timestamp));
  }

  AddStr(&content, "SIGNATURE_ALGORITHM", epm.signature_algorithm);

  {
    JsonValue proofs = JsonValue::Arr();
    for (const auto& p : epm.chain_proofs) {
      JsonValue entry = JsonValue::Obj();
      AddStr(&entry, "CHAIN", p.chain);
      AddStr(&entry, "ADDRESS", p.address);
      AddStr(&entry, "PUBLIC_KEY", p.public_key);
      AddStr(&entry, "KEY_PATH", p.key_path);
      AddStr(&entry, "SIGNATURE", p.signature);
      AddStr(&entry, "SIGNED_PAYLOAD", p.signed_payload);
      AddStr(&entry, "ALGORITHM", p.algorithm);
      AddStr(&entry, "ENCODING", p.encoding);
      if (!entry.object.empty()) proofs.array.push_back(std::move(entry));
    }
    if (!proofs.array.empty()) content.object.emplace_back("CHAIN_PROOFS", std::move(proofs));
  }

  return content;
}

std::string SigningContentBytes(const EpmFields& epm) {
  return jcs::Canonicalize(BuildSigningContent(epm));
}

}  // namespace sdn::epm
