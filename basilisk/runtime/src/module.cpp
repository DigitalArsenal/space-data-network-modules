/*
 * basilisk/runtime — typed contracts 1.0.
 *
 *   echo_xtc_dictionary          one "dictionary" $XTC in -> the same $XTC out (verbatim).
 *   run_pointing_power_scenario  one "scenario" $PPS (SCENARIO only) in -> one "telemetry" $PPS out: the SCENARIO
 *                                echoed with every default resolved, STATUS, PRODUCTS, ASSUMPTIONS and TELEMETRY
 *                                (column-major series parallel to ELAPSED_S).
 *
 * The pointing and power model is the module's simplified deterministic replay model, unchanged:
 *   pointing error  e(t) = e0 exp(-0.0075 t) + noise / 3600 * 0.1                     (deg)
 *   body rate       w(t) = w0 exp(-0.006 t)                                            (deg/s)
 *   wheel momentum  h(t) = h0 + w0 t 0.22                                              (N m s)
 *   relative pos.   (1200 - 1120 f, 45 sin(pi f), 18 cos(pi f)), f = t / duration      (m)
 *   illumination    s(t) = 0.58 + 0.22 cos(2 pi t / 5400)
 *   generated       P = area * solar constant * efficiency * s(t) * (1 - degradation * t / year)   (W)
 *   load            L = base load + 18 h(t) + 0.7 noise                                (W)
 *   battery         soc += (P - L) * step * eta / (capacity * 3600), clamped to [0, 1]; eta = charge efficiency
 *                   when charging, 1 / discharge efficiency when discharging
 *   mode            FineTrack while e < fine-pointing threshold, else Slew
 * at most 256 samples, every STEP_S from 0 to DURATION_S.
 *
 * Defaults (the values the JSON-era module used, now stated in the answer's SCENARIO):
 *   SOLAR_ARRAY.EFFICIENCY 0 -> 0.29          (formerly a hidden constant)
 *   BATTERY.CAPACITY_WH 0 -> BUS_SPECIFICATION.BATTERY_CAPACITY, else 14000 Wh   (formerly hidden)
 *   BUS_LOAD_W 0 -> 650 W base load           (formerly hidden)
 *   SOLAR_ARRAY.SOLAR_CONSTANT_W_M2 0 -> 1361; FINE_POINTING_THRESHOLD_DEG 0 -> 0.5;
 *   BATTERY.CHARGE_EFFICIENCY / DISCHARGE_EFFICIENCY 0 -> 1; BATTERY.INITIAL_STATE_OF_CHARGE NaN -> 0.72;
 *   no SOLAR_ARRAY -> AREA_M2 12; DURATION_S 0 -> 600; STEP_S 0 -> 60.
 * DURATION_S is clamped to [1, 86400] and STEP_S to [1, DURATION_S], as before. Other values are taken as given.
 *
 * STATUS is Nominal, or Degraded when a constraint the scenario sets is violated (state of charge below
 * BATTERY.MIN_STATE_OF_CHARGE, wheel momentum above WHEEL_MOMENTUM_CAPACITY_NMS). POINTING segments,
 * INITIAL_ATTITUDE, BUS_SPECIFICATION (but its battery capacity), TRAJECTORY and SOLAR_ARRAY.NORMAL_BODY are not
 * modelled; the nested $ACM / $BUS / $OEM tables are not echoed.
 */

#include <cmath>
#include <cstdint>
#include <cstring>
#include <limits>
#include <string>
#include <vector>

#include "space_data_module_invoke.h"
#include "PPS_generated.h"  // spacedatastandards.org lib/cpp/{ACM,BUS,...,OEM,PPS}/main_generated.h, inlined by build.mjs

extern "C" {

/* The dictionary port carries one SDS $XTC FlatBuffer. The frame must name
 * that type and the payload must carry the $XTC file identifier; it is echoed
 * verbatim on the typed dictionary output. */
int echo_xtc_dictionary(void) {
  plugin_reset_output_state();

  const plugin_input_frame_t *frame = plugin_get_input_frame(0);
  if (!frame || !frame->payload || frame->payload_length < 8) {
    plugin_set_error("missing-dictionary", "No XTC dictionary frame was provided.");
    return 3;
  }
  if (frame->wire_format != PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER ||
      !frame->file_identifier || strcmp(frame->file_identifier, "$XTC") != 0 ||
      memcmp(frame->payload + 4, "$XTC", 4) != 0) {
    plugin_set_error("invalid-dictionary", "The dictionary frame is not an SDS $XTC FlatBuffer.");
    return 3;
  }

  if (plugin_push_output_ex(
        "dictionary",
        "XTC.fbs",
        "$XTC",
        PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER,
        "XTC",
        0,
        0,
        frame->payload,
        frame->payload_length) < 0) {
    plugin_set_error("output-failed", "The $XTC dictionary could not be emitted.");
    return 4;
  }
  return 0;
}

}  // extern "C"

namespace {

namespace fb = flatbuffers;

constexpr const char* kProvider = "com.digitalarsenal.basilisk.runtime";
constexpr int kMaxSamples = 256;

double clamp(double value, double min_value, double max_value) {
  if (value < min_value) return min_value;
  if (value > max_value) return max_value;
  return value;
}

int push_pps(fb::FlatBufferBuilder& b) {
  if (plugin_push_output_ex("telemetry", "PPS.fbs", PPSIdentifier(), PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, "PPS", 0, 0,
                            b.GetBufferPointer(), static_cast<uint32_t>(b.GetSize())) < 0) {
    plugin_set_error("output-failed", "The $PPS telemetry could not be emitted.");
    return 4;
  }
  return 0;
}

int answer_invalid(const PPS* req, const char* code, const char* message) {
  fb::FlatBufferBuilder b(256);
  const char* run_id = req && req->RUN_ID() ? req->RUN_ID()->c_str() : nullptr;
  FinishPPSBuffer(b, CreatePPSDirect(b, run_id, 0, kProvider, 0, ppsStatus_InvalidRequest, code, message));
  return push_pps(b);
}

}  // namespace

extern "C" {

int run_pointing_power_scenario(void) {
  plugin_reset_output_state();

  const plugin_input_frame_t* frame = plugin_get_input_frame(0);
  if (!frame || !frame->payload || frame->payload_length == 0) {
    plugin_set_error("missing-scenario", "No $PPS scenario frame was provided.");
    return 3;
  }
  fb::Verifier verifier(frame->payload, frame->payload_length);
  if (!VerifyPPSBuffer(verifier)) {
    plugin_set_error("invalid-scenario", "The scenario frame is not a verifiable SDS $PPS.");
    return 3;
  }
  const PPS* req = GetPPS(frame->payload);
  const ppsScenario* s = req->SCENARIO();
  if (!s) return answer_invalid(req, "missing-scenario", "The $PPS request carries no SCENARIO.");

  const std::string scenario_id = s->SCENARIO_ID() && s->SCENARIO_ID()->size() > 0 ? s->SCENARIO_ID()->str()
                                                                                  : "basilisk-pointing-power";
  const double duration_seconds = clamp(s->DURATION_S() != 0.0 ? s->DURATION_S() : 600.0, 1.0, 86400.0);
  const double step_seconds = clamp(s->STEP_S() != 0.0 ? s->STEP_S() : 60.0, 1.0, duration_seconds);
  const double initial_attitude_error_deg = std::fmax(0.0, s->INITIAL_POINTING_ERROR_DEG());
  const double body_rate_deg_sec = std::fmax(0.0, s->INITIAL_BODY_RATE_DEG_S());
  const double initial_wheel_momentum_nms = std::fmax(0.0, s->INITIAL_WHEEL_MOMENTUM_NMS());
  const double sensor_noise_arcsec = std::fmax(0.0, s->SENSOR_NOISE_ARCSEC());
  const double fine_threshold_deg = s->FINE_POINTING_THRESHOLD_DEG() > 0.0 ? s->FINE_POINTING_THRESHOLD_DEG() : 0.5;
  const double base_load_w = s->BUS_LOAD_W() != 0.0 ? s->BUS_LOAD_W() : 650.0;
  const double wheel_capacity_nms = s->WHEEL_MOMENTUM_CAPACITY_NMS();

  const ppsSolarArray* array = s->SOLAR_ARRAY();
  const double solar_array_area_m2 = array ? std::fmax(0.0, array->AREA_M2()) : 12.0;
  const double efficiency = array && array->EFFICIENCY() > 0.0 ? array->EFFICIENCY() : 0.29;
  const double solar_constant = array && array->SOLAR_CONSTANT_W_M2() > 0.0 ? array->SOLAR_CONSTANT_W_M2() : 1361.0;
  const double degradation_per_year = array ? array->DEGRADATION_PER_YEAR() : 0.0;

  const ppsBattery* battery = s->BATTERY();
  const double bus_capacity_wh = s->BUS_SPECIFICATION() ? s->BUS_SPECIFICATION()->BATTERY_CAPACITY() : 0.0;
  const double capacity_wh = battery && battery->CAPACITY_WH() > 0.0 ? battery->CAPACITY_WH()
                             : bus_capacity_wh > 0.0              ? bus_capacity_wh
                                                                  : 14000.0;
  const double initial_soc = battery && !std::isnan(battery->INITIAL_STATE_OF_CHARGE())
                                 ? clamp(battery->INITIAL_STATE_OF_CHARGE(), 0.0, 1.0)
                                 : 0.72;
  const double min_soc = battery ? battery->MIN_STATE_OF_CHARGE() : 0.0;
  const double charge_efficiency = battery && battery->CHARGE_EFFICIENCY() > 0.0 ? battery->CHARGE_EFFICIENCY() : 1.0;
  const double discharge_efficiency =
      battery && battery->DISCHARGE_EFFICIENCY() > 0.0 ? battery->DISCHARGE_EFFICIENCY() : 1.0;

  std::vector<double> elapsed_s, pointing_error, body_rate, wheel, noise, relative, illumination, generated, load, net,
      soc_series, energy;
  std::vector<uint8_t> modes;
  double battery_soc = initial_soc;
  bool degraded = false;

  const int sample_count = (int)std::floor(duration_seconds / step_seconds) + 1;
  for (int index = 0; index < sample_count && index < kMaxSamples; ++index) {
    const double elapsed = std::fmin(duration_seconds, index * step_seconds);
    const double noise_floor_deg = sensor_noise_arcsec / 3600.0 * 0.1;
    const double attitude_error_deg = initial_attitude_error_deg * std::exp(-0.0075 * elapsed) + noise_floor_deg;
    const double wheel_momentum_nms = initial_wheel_momentum_nms + body_rate_deg_sec * elapsed * 0.22;
    const double approach_fraction = duration_seconds > 0.0 ? elapsed / duration_seconds : 0.0;
    const double sun_factor = 0.58 + 0.22 * std::cos(elapsed / 5400.0 * 6.283185307179586);
    double generated_power_w = solar_array_area_m2 * solar_constant * efficiency * sun_factor;
    if (degradation_per_year != 0.0) generated_power_w *= 1.0 - degradation_per_year * elapsed / 31557600.0;
    const double bus_load_w = base_load_w + 18.0 * wheel_momentum_nms + 0.7 * sensor_noise_arcsec;
    const double net_power_w = generated_power_w - bus_load_w;
    if (index > 0) {
      const double stored_w = net_power_w > 0.0 ? net_power_w * charge_efficiency : net_power_w / discharge_efficiency;
      battery_soc = clamp(battery_soc + stored_w * step_seconds / (capacity_wh * 3600.0), 0.0, 1.0);
    }
    if ((min_soc > 0.0 && battery_soc < min_soc) || (wheel_capacity_nms > 0.0 && wheel_momentum_nms > wheel_capacity_nms))
      degraded = true;

    elapsed_s.push_back(elapsed);
    modes.push_back(attitude_error_deg < fine_threshold_deg ? ppsAttitudeMode_FineTrack : ppsAttitudeMode_Slew);
    pointing_error.push_back(attitude_error_deg);
    body_rate.push_back(body_rate_deg_sec * std::exp(-0.006 * elapsed));
    wheel.push_back(wheel_momentum_nms);
    noise.push_back(sensor_noise_arcsec);
    relative.push_back(1200.0 - 1120.0 * approach_fraction);
    relative.push_back(45.0 * std::sin(approach_fraction * 3.141592653589793));
    relative.push_back(18.0 * std::cos(approach_fraction * 3.141592653589793));
    illumination.push_back(sun_factor);
    generated.push_back(generated_power_w);
    load.push_back(bus_load_w);
    net.push_back(net_power_w);
    soc_series.push_back(battery_soc);
    energy.push_back(battery_soc * capacity_wh);
  }

  fb::FlatBufferBuilder b(4096);
  std::vector<fb::Offset<ppsPointingSegment>> segments;
  if (s->POINTING()) {
    for (const ppsPointingSegment* seg : *s->POINTING()) {
      std::vector<double> axis;
      if (seg->BODY_AXIS()) axis.assign(seg->BODY_AXIS()->begin(), seg->BODY_AXIS()->end());
      segments.push_back(CreateppsPointingSegmentDirect(b, seg->MODE(), seg->START_S(),
                                                        seg->TARGET_ID() ? seg->TARGET_ID()->c_str() : nullptr,
                                                        seg->BODY_AXIS() ? &axis : nullptr));
    }
  }
  std::vector<double> normal;
  if (array && array->NORMAL_BODY()) normal.assign(array->NORMAL_BODY()->begin(), array->NORMAL_BODY()->end());
  const auto solar = CreateppsSolarArrayDirect(b, solar_array_area_m2, efficiency, solar_constant,
                                               array && array->NORMAL_BODY() ? &normal : nullptr, degradation_per_year);
  const auto batt = CreateppsBattery(b, capacity_wh, initial_soc, min_soc, charge_efficiency, discharge_efficiency);
  const auto str = [&](const fb::String* v) { return v ? v->c_str() : nullptr; };
  const auto scenario = CreateppsScenarioDirect(
      b, scenario_id.c_str(), str(s->NAME()), s->START_EPOCH_MS(), duration_seconds, step_seconds, str(s->OBJECT_ID()), 0,
      0, s->POINTING() ? &segments : nullptr, 0, initial_attitude_error_deg, body_rate_deg_sec,
      initial_wheel_momentum_nms, wheel_capacity_nms, fine_threshold_deg, solar, batt, base_load_w, sensor_noise_arcsec,
      str(s->RELATIVE_TARGET_ID()));
  const auto telemetry = CreateppsTelemetryDirect(
      b, static_cast<uint32_t>(elapsed_s.size()), &elapsed_s, &modes, &pointing_error, &body_rate, nullptr, nullptr,
      &wheel, &noise, &relative, &illumination, nullptr, &generated, &load, &net, &soc_series, &energy);
  const std::vector<uint8_t> products = {ppsProduct_Attitude, ppsProduct_Power, ppsProduct_Sensor,
                                         ppsProduct_RelativeMotion};
  const std::vector<fb::Offset<fb::String>> assumptions = {
      b.CreateString("deterministic Basilisk runtime replay surface"),
      b.CreateString("power balance uses the scenario's solar efficiency and bus load (defaults 0.29 and 650 W)"),
      b.CreateString("sensor noise floor is reported with each attitude sample"),
      b.CreateString("illumination is a fixed 5400 s cycle; no eclipse, trajectory or pointing-segment geometry"),
      b.CreateString("relative position is a scripted approach profile, not propagated"),
  };
  FinishPPSBuffer(b, CreatePPSDirect(b, req->RUN_ID() ? req->RUN_ID()->c_str() : nullptr, 0, kProvider, scenario,
                                     degraded ? ppsStatus_Degraded : ppsStatus_Nominal, nullptr, nullptr, &products,
                                     &assumptions, telemetry));
  return push_pps(b);
}

}  // extern "C"
