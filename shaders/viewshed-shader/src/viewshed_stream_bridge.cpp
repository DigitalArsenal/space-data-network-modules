#include "generated/PluginMessage_generated.h"
#include "generated/TypedArenaBuffer_generated.h"
#include <emscripten.h>
#include <flatbuffers/flatbuffers.h>
#include <cstdint>
#include <cstring>
#include <string>
#include <vector>

extern "C" {
void* orbpro_malloc(size_t size);
void orbpro_free(void* ptr);
int orbpro_is_initialized(void);
const char* get_fragment_source(void);
const char* get_vertex_source(void);
const char* get_uniforms(void);
const char* get_defines(void);
const char* get_frustum_vertex_source(void);
const char* get_frustum_fragment_source(void);
}

namespace {

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
  return copyFlatBufferToHeap(builder.GetBufferPointer(), builder.GetSize(), sizeOut);
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

uint8_t* encodeRawDataPayload(
    const char* typeId,
    const char* text,
    uint32_t* payloadSizeOut) {
  const char* safeTypeId = typeId != nullptr ? typeId : "application/octet-stream";
  const char* safeText = text != nullptr ? text : "";

  flatbuffers::FlatBufferBuilder builder(512);
  const auto typeIdOffset = builder.CreateString(safeTypeId);
  const auto dataOffset = builder.CreateVector(
      reinterpret_cast<const uint8_t*>(safeText),
      std::strlen(safeText));
  const auto payload =
      orbpro::plugin::CreateRawDataPayload(builder, typeIdOffset, dataOffset);
  builder.Finish(payload);
  return copyFlatBufferToHeap(builder, payloadSizeOut);
}

uint8_t* buildRawDataStreamInvokeResponse(
    const char* portId,
    const char* typeId,
    const char* text,
    uint32_t* responseSizeOut) {
  uint32_t payloadSize = 0;
  uint8_t* payloadBytes = encodeRawDataPayload(typeId, text, &payloadSize);
  if (payloadBytes == nullptr) {
    return buildErrorStreamInvokeResponse(
        -1,
        "Failed to encode viewshed shader stream response payload.",
        responseSizeOut);
  }

  flatbuffers::FlatBufferBuilder builder(512);
  const auto typeRef = orbpro::stream::CreateFlatBufferTypeRefDirect(
      builder,
      "orbpro.plugin.RawDataPayload",
      nullptr,
      nullptr,
      false);
  const auto output = orbpro::stream::CreateTypedArenaBufferDirect(
      builder,
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
      builder,
      builder.CreateVector(&output, 1),
      0,
      false,
      0,
      0);
  builder.Finish(response);
  return copyFlatBufferToHeap(builder, responseSizeOut);
}

}  // namespace

extern "C" {

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

  if (!orbpro_is_initialized()) {
    return buildErrorStreamInvokeResponse(
        -1,
        "Viewshed shader runtime is not initialized.",
        responseSizeOut);
  }

  const std::string methodId = request->method_id()->str();
  const char* text = nullptr;
  const char* typeId = nullptr;
  const char* portId = nullptr;

  if (methodId == "compile_program") {
    return buildRawDataStreamInvokeResponse(
        "compiled",
        "application/json;orbpro.viewshed.compile-status",
        "{\"compiled\":true}",
        responseSizeOut);
  } else if (methodId == "get_fragment_source") {
    text = get_fragment_source();
    typeId = "text/plain;orbpro.viewshed.fragment";
    portId = "fragment_source";
  } else if (methodId == "get_vertex_source") {
    text = get_vertex_source();
    typeId = "text/plain;orbpro.viewshed.vertex";
    portId = "vertex_source";
  } else if (methodId == "get_uniforms") {
    text = get_uniforms();
    typeId = "application/json;orbpro.viewshed.uniforms";
    portId = "uniforms";
  } else if (methodId == "get_defines") {
    text = get_defines();
    typeId = "application/json;orbpro.viewshed.defines";
    portId = "defines";
  } else if (methodId == "get_frustum_vertex_source") {
    text = get_frustum_vertex_source();
    typeId = "text/plain;orbpro.viewshed.frustum-vertex";
    portId = "frustum_vertex_source";
  } else if (methodId == "get_frustum_fragment_source") {
    text = get_frustum_fragment_source();
    typeId = "text/plain;orbpro.viewshed.frustum-fragment";
    portId = "frustum_fragment_source";
  } else {
    return buildErrorStreamInvokeResponse(
        -1,
        "Unsupported stream method for viewshed shader plugin.",
        responseSizeOut);
  }

  return buildRawDataStreamInvokeResponse(
      portId,
      typeId,
      text,
      responseSizeOut);
}

}  // extern "C"
