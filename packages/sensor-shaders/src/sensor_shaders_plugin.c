#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>

#include <emscripten.h>

static const char* ORBPRO_SENSOR_SHADERS_NAME = "OrbPro Sensor Shaders";
static const char* ORBPRO_SENSOR_SHADERS_VERSION = "1.0.0";
static const char* ORBPRO_SENSOR_SHADERS_TYPE = "Shader";

void sensor_shaders_stream_cleanup(void);

EMSCRIPTEN_KEEPALIVE
const char* get_name(void) {
  return ORBPRO_SENSOR_SHADERS_NAME;
}

EMSCRIPTEN_KEEPALIVE
const char* get_version(void) {
  return ORBPRO_SENSOR_SHADERS_VERSION;
}

EMSCRIPTEN_KEEPALIVE
const char* get_type(void) {
  return ORBPRO_SENSOR_SHADERS_TYPE;
}

EMSCRIPTEN_KEEPALIVE
void orbpro_cleanup(void) {
  sensor_shaders_stream_cleanup();
}

EMSCRIPTEN_KEEPALIVE
void* orbpro_malloc(size_t size) {
  return malloc(size);
}

EMSCRIPTEN_KEEPALIVE
void orbpro_free(void* ptr) {
  free(ptr);
}
