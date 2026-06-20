#if defined(__has_include)
#if __has_include("sensor_shape_model.h")
#include "sensor_shape_model.h"
#if __has_include("sensor_shape_model.cpp.inc")
#include "sensor_shape_model.cpp.inc"
#endif
#define SDN_SENSOR_SHAPE_MODEL_INCLUDED 1
#endif
#endif

#include <string>
#include <vector>

using namespace sdn_hypersonics;

extern "C" int evaluate_sensor_shape(void) {
  plugin_reset_output_state();
  const std::string request_payload = payload_for_port("sensor");
  if (request_payload.empty()) {
    return fail("missing-sensor", "Input port \"sensor\" is required.");
  }
  flatbuffers::Verifier verifier(
      reinterpret_cast<const uint8_t*>(request_payload.data()),
      request_payload.size());
  if (!VerifySCVBuffer(verifier)) {
    return fail(
        "invalid-scv",
        "Input port \"sensor\" must contain a valid SCV FlatBuffer.");
  }
  const SCV* envelope = GetSCV(request_payload.data());
  if (!envelope ||
      envelope->ENVELOPE_KIND() != scvEnvelopeKind_REQUEST ||
      !envelope->REQUEST()) {
    return fail(
        "invalid-envelope",
        "Input port \"sensor\" SCV envelope must contain a REQUEST payload.");
  }

  flatbuffers::FlatBufferBuilder builder(1024);
  auto message = builder.CreateString("sensor-model evaluated SCV sensor contract");
  auto result = CreateSCVResult(
      builder,
      builder.CreateString("sensor-model"),
      0,
      scvResultState_OK,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      message);
  auto scv = CreateSCV(builder, scvEnvelopeKind_RESULT, 0, 0, 0, result, 0);
  FinishSCVBuffer(builder, scv);
  return emit_bytes(
      "result",
      "SCV/main.fbs",
      "$SCV",
      builder.GetBufferPointer(),
      static_cast<uint32_t>(builder.GetSize()));
}
