// ocm_to_vcm: one $OCM, and optionally the states at its epoch as $OEM, to the
// SP Vector/Covariance Message V2.0 text, framed as files/orbit-products'
// normalize_vcm reads it: a size-prefixed $NCD (PROVIDER_DEFINED,
// "vcm-v2-text", the text's SHA-256 and byte length) followed by the text.
// Compiled after the generated SDS headers, sha256.hpp, vcm.hpp, vcm_write.hpp
// and vcm_draft.hpp.
#include <cstdint>
#include <string>
#include <vector>

#include "space_data_module_invoke.h"

namespace {

// Aligned copy of one input frame, plain or size-prefixed, verified.
template <class T, class Verify, class VerifyPrefixed, class Has, class HasPrefixed, class Get, class GetPrefixed>
bool unpackFrame(const plugin_input_frame_t* frame, T& out, Verify verify, VerifyPrefixed verifyPrefixed, Has has, HasPrefixed hasPrefixed,
                 Get get, GetPrefixed getPrefixed) {
  if (!frame || !frame->payload || frame->payload_length < 8) return false;
  std::vector<uint8_t> bytes(frame->payload, frame->payload + frame->payload_length);
  flatbuffers::Verifier verifier(bytes.data(), bytes.size());
  if (has(bytes.data()) && verify(verifier)) { get(bytes.data())->UnPackTo(&out); return true; }
  if (bytes.size() >= 12 && hasPrefixed(bytes.data()) && verifyPrefixed(verifier)) { getPrefixed(bytes.data())->UnPackTo(&out); return true; }
  return false;
}

int refuse(const char* code, const std::string& message) {
  plugin_set_error(code, (message + "; no output was published.").c_str());
  return 400;
}

}  // namespace

extern "C" int ocm_to_vcm(void) {
  const int32_t index = plugin_find_input_index("ocm", 0);
  if (index < 0) return refuse("missing-ocm", "ocm_to_vcm requires one $OCM on port \"ocm\"");
  if (plugin_find_input_index("ocm", 1) >= 0) return refuse("invalid-ocm", "ocm_to_vcm writes one message from one $OCM");
  OCMT ocm;
  if (!unpackFrame(plugin_get_input_frame(static_cast<uint32_t>(index)), ocm,
                   [](flatbuffers::Verifier& v) { return VerifyOCMBuffer(v); }, [](flatbuffers::Verifier& v) { return VerifySizePrefixedOCMBuffer(v); },
                   [](const uint8_t* b) { return OCMBufferHasIdentifier(b); }, [](const uint8_t* b) { return SizePrefixedOCMBufferHasIdentifier(b); },
                   [](const uint8_t* b) { return GetOCM(b); }, [](const uint8_t* b) { return GetSizePrefixedOCM(b); }))
    return refuse("invalid-ocm", "the \"ocm\" frame is not a verifiable $OCM buffer");

  std::vector<sdn::vcm::write::Supplied> states;
  sdn::vcm::write::Refusal refusal;
  for (uint32_t k = 0;; ++k) {
    const int32_t at = plugin_find_input_index("state", k);
    if (at < 0) break;
    OEMT oem;
    if (!unpackFrame(plugin_get_input_frame(static_cast<uint32_t>(at)), oem,
                     [](flatbuffers::Verifier& v) { return VerifyOEMBuffer(v); }, [](flatbuffers::Verifier& v) { return VerifySizePrefixedOEMBuffer(v); },
                     [](const uint8_t* b) { return OEMBufferHasIdentifier(b); }, [](const uint8_t* b) { return SizePrefixedOEMBufferHasIdentifier(b); },
                     [](const uint8_t* b) { return GetOEM(b); }, [](const uint8_t* b) { return GetSizePrefixedOEM(b); }))
      return refuse("invalid-state", "a \"state\" frame is not a verifiable $OEM buffer");
    sdn::vcm::write::Supplied s;
    if (!sdn::vcm::write::supplied(oem, s, refusal)) return refuse(refusal.code.c_str(), refusal.message);
    states.push_back(s);
  }

  sdn::vcm::write::Draft draft;
  if (!sdn::vcm::write::draft(ocm, states, draft, refusal)) return refuse(refusal.code.c_str(), refusal.message);
  const std::string text = sdn::vcm::write::format(draft);

  // The optional configuration: the output descriptor's file name and content id.
  NCDT descriptor;
  const int32_t configured = plugin_find_input_index("descriptor", 0);
  if (configured >= 0) {
    NCDT incoming;
    if (!unpackFrame(plugin_get_input_frame(static_cast<uint32_t>(configured)), incoming,
                     [](flatbuffers::Verifier& v) { return VerifyNCDBuffer(v); }, [](flatbuffers::Verifier& v) { return VerifySizePrefixedNCDBuffer(v); },
                     [](const uint8_t* b) { return NCDBufferHasIdentifier(b); }, [](const uint8_t* b) { return SizePrefixedNCDBufferHasIdentifier(b); },
                     [](const uint8_t* b) { return GetNCD(b); }, [](const uint8_t* b) { return GetSizePrefixedNCD(b); }))
      return refuse("invalid-configuration", "the \"descriptor\" frame is not a verifiable $NCD buffer");
    const bool ours = incoming.FORMAT == ncdContainerFormat::PROVIDER_DEFINED && incoming.PROVIDER_DEFINED_FORMAT_NAME == "vcm-v2-text";
    if (incoming.FORMAT != ncdContainerFormat::UNSPECIFIED && !ours)
      return refuse("configuration-refused", "the \"descriptor\" FORMAT must be UNSPECIFIED or PROVIDER_DEFINED vcm-v2-text");
    descriptor.INTERNAL_FILE_NAME = incoming.INTERNAL_FILE_NAME;
    descriptor.SOURCE_CID = incoming.SOURCE_CID;
  }
  descriptor.FORMAT = ncdContainerFormat::PROVIDER_DEFINED;
  descriptor.PROVIDER_DEFINED_FORMAT_NAME = "vcm-v2-text";
  descriptor.PRODUCER = "com.digitalarsenal.files.vcm-text";
  descriptor.NATIVE_TIME_SYSTEM = "UTC";
  descriptor.SOURCE_BYTE_LENGTH = static_cast<uint64_t>(text.size());
  descriptor.SOURCE_SHA256 = ephem::sha256_hex(reinterpret_cast<const uint8_t*>(text.data()), text.size());
  flatbuffers::FlatBufferBuilder fbb(1024);
  fbb.FinishSizePrefixed(CreateNCD(fbb, &descriptor), NCDIdentifier());
  std::vector<uint8_t> frame(fbb.GetBufferPointer(), fbb.GetBufferPointer() + fbb.GetSize());
  frame.insert(frame.end(), text.begin(), text.end());
  return plugin_push_output_ex("message", "NCD.fbs", "$NCD", PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY, "NCD", 0, 8, frame.data(),
                               static_cast<uint32_t>(frame.size())) < 0
             ? 500
             : 0;
}
