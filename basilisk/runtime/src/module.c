#include <stdint.h>
#include <math.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "space_data_module_invoke.h"

static const char *find_key(const char *json, const char *key) {
  static char pattern[96];
  snprintf(pattern, sizeof(pattern), "\"%s\"", key);
  return strstr(json, pattern);
}

static double number_value(const char *json, const char *key, double fallback) {
  const char *key_pos = find_key(json, key);
  if (!key_pos) {
    return fallback;
  }
  const char *colon = strchr(key_pos, ':');
  if (!colon) {
    return fallback;
  }
  char *end = NULL;
  const double value = strtod(colon + 1, &end);
  return end == colon + 1 ? fallback : value;
}

static void string_value(const char *json, const char *key, const char *fallback, char *out, size_t out_len) {
  if (out_len == 0) {
    return;
  }
  const char *key_pos = find_key(json, key);
  const char *colon = key_pos ? strchr(key_pos, ':') : NULL;
  const char *open = colon ? strchr(colon + 1, '"') : NULL;
  if (!open) {
    snprintf(out, out_len, "%s", fallback);
    return;
  }
  size_t out_index = 0;
  for (const char *cursor = open + 1; *cursor && out_index + 1 < out_len; ++cursor) {
    if (*cursor == '"') {
      break;
    }
    if (*cursor == '\\' && cursor[1]) {
      ++cursor;
    }
    out[out_index++] = *cursor;
  }
  out[out_index] = '\0';
}

static double clamp(double value, double min_value, double max_value) {
  if (value < min_value) {
    return min_value;
  }
  if (value > max_value) {
    return max_value;
  }
  return value;
}

static void appendf(char *buffer, size_t capacity, size_t *offset, const char *format, ...) {
  if (*offset >= capacity) {
    return;
  }
  va_list args;
  va_start(args, format);
  const int written = vsnprintf(buffer + *offset, capacity - *offset, format, args);
  va_end(args);
  if (written > 0) {
    *offset += (size_t)written;
    if (*offset >= capacity) {
      *offset = capacity - 1;
    }
  }
}

int echo_xtc_dictionary(void) {
  const plugin_input_frame_t *frame = plugin_get_input_frame(0);
  if (!frame) {
    plugin_set_error("missing-dictionary", "No XTC dictionary frame was provided.");
    return 3;
  }

  plugin_push_output(
    "dictionary",
    frame->schema_name,
    frame->file_identifier,
    frame->payload,
    frame->payload_length
  );
  return 0;
}

int run_pointing_power_scenario(void) {
  plugin_reset_output_state();

  const plugin_input_frame_t *frame = plugin_get_input_frame(0);
  if (!frame || !frame->payload || frame->payload_length == 0) {
    plugin_set_error("missing-scenario", "No Basilisk scenario frame was provided.");
    return 3;
  }

  char request[4096];
  const uint32_t length = frame->payload_length < sizeof(request) - 1
    ? frame->payload_length
    : (uint32_t)sizeof(request) - 1;
  memcpy(request, frame->payload, length);
  request[length] = '\0';

  char scenario_id[128];
  string_value(request, "scenarioId", "basilisk-pointing-power", scenario_id, sizeof(scenario_id));

  const double duration_seconds = clamp(number_value(request, "durationSeconds", 600.0), 1.0, 86400.0);
  const double step_seconds = clamp(number_value(request, "stepSeconds", 60.0), 1.0, duration_seconds);
  const double initial_attitude_error_deg =
    fmax(0.0, number_value(request, "initialAttitudeErrorDeg", 5.0));
  const double body_rate_deg_sec = fmax(0.0, number_value(request, "bodyRateDegSec", 0.05));
  const double initial_wheel_momentum_nms =
    fmax(0.0, number_value(request, "wheelMomentumNms", 8.0));
  double battery_soc = clamp(number_value(request, "batteryStateOfCharge", 0.72), 0.0, 1.0);
  const double solar_array_area_m2 = fmax(0.0, number_value(request, "solarArrayAreaM2", 12.0));
  const double sensor_noise_arcsec = fmax(0.0, number_value(request, "sensorNoiseArcsec", 20.0));

  char response[16384];
  size_t offset = 0;
  appendf(
    response,
    sizeof(response),
    &offset,
    "{\"provider\":\"com.digitalarsenal.basilisk.runtime\","
    "\"scenarioId\":\"%s\",\"status\":\"nominal\","
    "\"products\":[\"attitude\",\"power\",\"sensor\"],"
    "\"assumptions\":[\"deterministic Basilisk runtime replay surface\","
    "\"power balance uses fixed solar efficiency and bus load\","
    "\"sensor noise floor is reported with each attitude sample\"],"
    "\"telemetry\":[",
    scenario_id);

  const int sample_count = (int)floor(duration_seconds / step_seconds) + 1;
  for (int index = 0; index < sample_count && index < 256; ++index) {
    const double elapsed = fmin(duration_seconds, index * step_seconds);
    const double noise_floor_deg = sensor_noise_arcsec / 3600.0 * 0.1;
    const double attitude_error_deg =
      initial_attitude_error_deg * exp(-0.0075 * elapsed) + noise_floor_deg;
    const double wheel_momentum_nms =
      initial_wheel_momentum_nms + body_rate_deg_sec * elapsed * 0.22;
    const double approach_fraction = duration_seconds > 0.0 ? elapsed / duration_seconds : 0.0;
    const double relative_x_m = 1200.0 - 1120.0 * approach_fraction;
    const double relative_y_m = 45.0 * sin(approach_fraction * 3.141592653589793);
    const double relative_z_m = 18.0 * cos(approach_fraction * 3.141592653589793);
    const double sun_factor = 0.58 + 0.22 * cos(elapsed / 5400.0 * 6.283185307179586);
    const double generated_power_w = solar_array_area_m2 * 1361.0 * 0.29 * sun_factor;
    const double bus_load_w = 650.0 + 18.0 * wheel_momentum_nms + 0.7 * sensor_noise_arcsec;
    const double net_power_w = generated_power_w - bus_load_w;
    if (index > 0) {
      battery_soc = clamp(battery_soc + net_power_w * step_seconds / (14000.0 * 3600.0), 0.0, 1.0);
    }
    appendf(
      response,
      sizeof(response),
      &offset,
      "%s{\"elapsedSeconds\":%.12g,\"attitudeErrorDeg\":%.12g,"
      "\"bodyRateDegSec\":%.12g,\"wheelMomentumNms\":%.12g,"
      "\"relativePositionM\":[%.12g,%.12g,%.12g],"
      "\"generatedPowerW\":%.12g,\"busLoadW\":%.12g,"
      "\"batteryStateOfCharge\":%.12g,\"sensorNoiseArcsec\":%.12g,"
      "\"pointingMode\":\"%s\"}",
      index == 0 ? "" : ",",
      elapsed,
      attitude_error_deg,
      body_rate_deg_sec * exp(-0.006 * elapsed),
      wheel_momentum_nms,
      relative_x_m,
      relative_y_m,
      relative_z_m,
      generated_power_w,
      bus_load_w,
      battery_soc,
      sensor_noise_arcsec,
      attitude_error_deg < 0.5 ? "fine-track" : "slew");
  }
  appendf(response, sizeof(response), &offset, "]}");

  plugin_push_output(
    "telemetry",
    "TAB.fbs",
    "$TAB",
    (const uint8_t *)response,
    (uint32_t)strlen(response)
  );
  return 0;
}
