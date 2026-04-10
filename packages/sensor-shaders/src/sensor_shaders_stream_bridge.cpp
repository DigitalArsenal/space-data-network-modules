#include "generated/PluginMessage_generated.h"
#include "generated/TypedArenaBuffer_generated.h"
#include <emscripten.h>
#include <flatbuffers/flatbuffers.h>
#include <cstdint>
#include <cstring>
#include <string>

extern "C" {
void* orbpro_malloc(size_t size);
void orbpro_free(void* ptr);
}

namespace {

std::string g_bundle_json;

uint8_t* copyFlatBufferToHeap(
    const uint8_t* bytes,
    size_t size,
    uint32_t* sizeOut) {
  if (sizeOut != nullptr) {
    *sizeOut = static_cast<uint32_t>(size);
  }
  if (bytes == nullptr || size == 0) {
    return nullptr;
  }

  auto* out = static_cast<uint8_t*>(orbpro_malloc(size));
  if (out == nullptr) {
    if (sizeOut != nullptr) {
      *sizeOut = 0;
    }
    return nullptr;
  }

  std::memcpy(out, bytes, size);
  return out;
}

uint8_t* copyFlatBufferToHeap(
    const flatbuffers::FlatBufferBuilder& builder,
    uint32_t* sizeOut) {
  return copyFlatBufferToHeap(
      builder.GetBufferPointer(),
      builder.GetSize(),
      sizeOut);
}

uint8_t* buildErrorStreamInvokeResponse(
    int32_t errorCode,
    const char* errorMessage,
    uint32_t* responseSizeOut) {
  flatbuffers::FlatBufferBuilder builder(256);
  const auto response = orbpro::plugin::CreateStreamInvokeResponseDirect(
      builder,
      nullptr,
      0,
      false,
      errorCode,
      errorMessage);
  builder.Finish(response);
  return copyFlatBufferToHeap(builder, responseSizeOut);
}

uint8_t* buildRawDataStreamInvokeResponse(
    const char* portId,
    const char* typeId,
    const char* text,
    uint32_t* responseSizeOut) {
  flatbuffers::FlatBufferBuilder payloadBuilder(512);
  const auto typeIdOffset =
      payloadBuilder.CreateString(typeId != nullptr ? typeId : "application/json");
  const auto dataOffset = payloadBuilder.CreateVector(
      reinterpret_cast<const uint8_t*>(text != nullptr ? text : ""),
      text != nullptr ? std::strlen(text) : 0);
  const auto payload =
      orbpro::plugin::CreateRawDataPayload(payloadBuilder, typeIdOffset, dataOffset);
  payloadBuilder.Finish(payload);

  uint32_t payloadSize = 0;
  uint8_t* payloadBytes =
      copyFlatBufferToHeap(payloadBuilder.GetBufferPointer(), payloadBuilder.GetSize(), &payloadSize);
  if (payloadBytes == nullptr) {
    return buildErrorStreamInvokeResponse(
        -1,
        "Failed to allocate sensor shader response payload.",
        responseSizeOut);
  }

  flatbuffers::FlatBufferBuilder responseBuilder(512);
  const auto typeRef = orbpro::stream::CreateFlatBufferTypeRefDirect(
      responseBuilder,
      "orbpro.plugin.RawDataPayload",
      nullptr,
      nullptr,
      false);
  const auto output = orbpro::stream::CreateTypedArenaBufferDirect(
      responseBuilder,
      typeRef,
      portId,
      8,
      static_cast<uint32_t>(reinterpret_cast<uintptr_t>(payloadBytes)),
      payloadSize,
      orbpro::stream::BufferOwnership_PRODUCER_OWNED,
      0,
      orbpro::stream::BufferMutability_IMMUTABLE,
      0,
      0,
      0,
      false);
  const auto response = orbpro::plugin::CreateStreamInvokeResponse(
      responseBuilder,
      responseBuilder.CreateVector(&output, 1),
      0,
      false,
      0,
      0);
  responseBuilder.Finish(response);
  return copyFlatBufferToHeap(responseBuilder, responseSizeOut);
}

}  // namespace

extern "C" {

EMSCRIPTEN_KEEPALIVE
int sensor_shaders_set_bundle_json(const uint8_t* data, size_t size) {
  if (data == nullptr || size == 0) {
    g_bundle_json.clear();
    return 1;
  }

  g_bundle_json.assign(reinterpret_cast<const char*>(data), size);
  return 1;
}

EMSCRIPTEN_KEEPALIVE
void sensor_shaders_stream_cleanup(void) {
  g_bundle_json.clear();
}

EMSCRIPTEN_KEEPALIVE
uint8_t* plugin_stream_invoke(
    const uint8_t* requestData,
    size_t requestSize,
    uint32_t* responseSizeOut) {
  if (responseSizeOut != nullptr) {
    *responseSizeOut = 0;
  }
  if (requestData == nullptr || requestSize == 0) {
    return buildErrorStreamInvokeResponse(
        -1,
        "Missing stream invoke request bytes.",
        responseSizeOut);
  }

  flatbuffers::Verifier verifier(requestData, requestSize);
  if (!verifier.VerifyBuffer<orbpro::plugin::StreamInvokeRequest>(nullptr)) {
    return buildErrorStreamInvokeResponse(
        -1,
        "Invalid StreamInvokeRequest payload.",
        responseSizeOut);
  }

  const auto* request =
      flatbuffers::GetRoot<orbpro::plugin::StreamInvokeRequest>(requestData);
  if (request == nullptr || request->method_id() == nullptr) {
    return buildErrorStreamInvokeResponse(
        -1,
        "StreamInvokeRequest is missing method_id.",
        responseSizeOut);
  }
  if (g_bundle_json.empty()) {
    return buildErrorStreamInvokeResponse(
        -1,
        "Sensor shader bundle is not loaded.",
        responseSizeOut);
  }

  const std::string methodId = request->method_id()->str();
  if (methodId == "load_shader_bundle") {
    return buildRawDataStreamInvokeResponse(
        "bundle",
        "application/json;orbpro.sensor-shaders.load-status",
        g_bundle_json.c_str(),
        responseSizeOut);
  }
  if (methodId == "get_shader_bundle") {
    return buildRawDataStreamInvokeResponse(
        "bundle",
        "application/json;orbpro.sensor-shaders.bundle",
        g_bundle_json.c_str(),
        responseSizeOut);
  }

  return buildErrorStreamInvokeResponse(
      -1,
      "Unsupported stream method for sensor shader plugin.",
      responseSizeOut);
}

}  // extern "C"
