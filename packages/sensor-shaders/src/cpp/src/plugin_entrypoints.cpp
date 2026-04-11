#include "generated/PluginMessage_generated.h"
#include "sensor_shaders_plugin_manifest_bytes.h"
#include "space_data_module_invoke.h"

#include <cstdlib>
#include <cstdint>
#include <cstring>
#include <string_view>

#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#else
#define EMSCRIPTEN_KEEPALIVE
#endif

namespace {

constexpr const char* kSensorShadersName = "OrbPro Sensor Shaders";
constexpr const char* kSensorShadersVersion = "1.0.0";
constexpr const char* kSensorShadersType = "Shader";
constexpr const char* kRawDataSchemaName = "orbpro.plugin.RawDataPayload";
constexpr const char* kLoadStatusTypeId =
    "application/json;orbpro.sensor-shaders.load-status";
constexpr const char* kBundleTypeId =
    "application/json;orbpro.sensor-shaders.bundle";

uint8_t* g_bundle_json = nullptr;
uint32_t g_bundle_json_size = 0u;

void clear_bundle_json() {
    if (g_bundle_json != nullptr) {
        std::free(g_bundle_json);
        g_bundle_json = nullptr;
    }
    g_bundle_json_size = 0u;
}

bool emit_bundle_payload(std::string_view type_id) {
    if (g_bundle_json == nullptr || g_bundle_json_size == 0u) {
        plugin_set_error(
            "bundle-not-loaded",
            "Sensor shader bundle is not loaded.");
        return false;
    }

    flatbuffers::FlatBufferBuilder builder(
        256u + g_bundle_json_size);
    const auto type_id_offset = builder.CreateString(type_id.data(), type_id.size());
    const auto payload_offset = builder.CreateVector(
        g_bundle_json,
        g_bundle_json_size);
    const auto payload = orbpro::plugin::CreateRawDataPayload(
        builder,
        type_id_offset,
        payload_offset);
    builder.Finish(payload);

    return plugin_push_output(
               "bundle",
               kRawDataSchemaName,
               nullptr,
               builder.GetBufferPointer(),
               static_cast<uint32_t>(builder.GetSize())) >= 0;
}

int handle_bundle_request(std::string_view type_id) {
    if (!emit_bundle_payload(type_id)) {
        if (g_bundle_json == nullptr || g_bundle_json_size == 0u) {
            return 1;
        }
        plugin_set_error(
            "emit-failed",
            "Failed to emit sensor shader bundle response.");
        return 1;
    }
    return 0;
}

}  // namespace

extern "C" {

EMSCRIPTEN_KEEPALIVE
const uint8_t* plugin_get_manifest_flatbuffer(void) {
    return sensor_shaders_plugin_manifest_bytes;
}

EMSCRIPTEN_KEEPALIVE
uint32_t plugin_get_manifest_flatbuffer_size(void) {
    return static_cast<uint32_t>(sensor_shaders_plugin_manifest_bytes_size);
}

EMSCRIPTEN_KEEPALIVE
const char* get_name(void) {
    return kSensorShadersName;
}

EMSCRIPTEN_KEEPALIVE
const char* get_version(void) {
    return kSensorShadersVersion;
}

EMSCRIPTEN_KEEPALIVE
const char* get_type(void) {
    return kSensorShadersType;
}

EMSCRIPTEN_KEEPALIVE
int sensor_shaders_set_bundle_json(const uint8_t* data, uint32_t size) {
    clear_bundle_json();

    if (data == nullptr || size == 0u) {
        return 1;
    }

    g_bundle_json = static_cast<uint8_t*>(std::malloc(size));
    if (g_bundle_json == nullptr) {
        plugin_set_error(
            "bundle-alloc-failed",
            "Failed to allocate sensor shader bundle storage.");
        return 0;
    }
    std::memcpy(g_bundle_json, data, size);
    g_bundle_json_size = size;
    return 1;
}

EMSCRIPTEN_KEEPALIVE
void sensor_shaders_stream_cleanup(void) {
    clear_bundle_json();
}

EMSCRIPTEN_KEEPALIVE
int load_shader_bundle(void) {
    return handle_bundle_request(kLoadStatusTypeId);
}

EMSCRIPTEN_KEEPALIVE
int get_shader_bundle(void) {
    return handle_bundle_request(kBundleTypeId);
}

}  // extern "C"
