using namespace sdn_hypersonics;

extern "C" int evaluate_hypersonic_state_batch(void) {
  plugin_reset_output_state();

  const std::string request = payload_for_port("trajectory");
  if (request.empty()) {
    return fail("missing-trajectory", "Input port \"trajectory\" is required.");
  }

  const std::string atmosphere_provider =
    string_value(request, "atmosphereProvider", "atmosphere-model");
  const std::string atmosphere_model =
    string_value(request, "atmosphereModel", "US76");
  const Vehicle vehicle = parse_vehicle(request);
  std::vector<Sample> samples = parse_samples(request, "states");
  if (samples.empty()) {
    samples = parse_samples(request, "samples");
  }
  if (samples.empty()) {
    return fail("missing-states", "Request must include a non-empty states array.");
  }

  // Fail hard on unsupported atmosphere models (e.g. "NRLMSISE00") before
  // doing any work — no silent fallbacks.
  {
    const AtmosphereState probe = atmosphere_for_model(0.0, atmosphere_model);
    if (!probe.valid) {
      return fail("unsupported-atmosphere-model", probe.error.c_str());
    }
  }

  std::vector<HypersonicCondition> conditions;
  conditions.reserve(samples.size());
  for (const auto& sample : samples) {
    HypersonicCondition condition = compute_condition(sample, vehicle, atmosphere_model);
    if (!condition.atmosphere.valid) {
      return fail("unsupported-atmosphere-model", condition.atmosphere.error.c_str());
    }
    conditions.push_back(condition);
  }

  std::string response =
    "{\"provider\":\"hypersonics-propagator\","
    "\"atmosphereProvider\":" + quote(atmosphere_provider) + ","
    "\"atmosphereModel\":" + quote(atmosphere_model) + ","
    "\"count\":" + std::to_string(conditions.size()) + ","
    "\"conditions\":" + join_conditions(conditions) + ","
    "\"assumptions\":[\"US Standard Atmosphere 1976 below 86 km (geopotential-corrected)\","
    "\"Sutton-Graves stagnation-point convective heating\","
    "\"perfect-gas Mach number using gamma=1.4\"]}";

  return emit_json("conditions", "HFC.fbs", "$HFC", response);
}
