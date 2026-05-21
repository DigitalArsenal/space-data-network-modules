using namespace sdn_hypersonics;

namespace {

std::string trajectory_samples_json(const std::vector<HypersonicCondition>& conditions) {
  std::string output = "[";
  for (size_t index = 0; index < conditions.size(); ++index) {
    if (index > 0) {
      output += ",";
    }
    output += condition_json(conditions[index]);
  }
  output += "]";
  return output;
}

}  // namespace

extern "C" int simulate_reentry(void) {
  plugin_reset_output_state();

  const std::string request = payload_for_port("scenario");
  if (request.empty()) {
    return fail("missing-scenario", "Input port \"scenario\" is required.");
  }

  const std::string atmosphere_provider =
    string_value(request, "atmosphereProvider", "atmosphere-model");
  const std::string hypersonics_provider =
    string_value(request, "hypersonicsProvider", "hypersonics-propagator");
  const std::string atmosphere_model =
    string_value(request, "atmosphereModel", "US76");
  const Vehicle vehicle = parse_vehicle(request);
  const std::vector<Sample> samples = parse_samples(request, "samples");
  if (samples.empty()) {
    return fail("missing-samples", "Request must include a non-empty samples array.");
  }

  std::vector<HypersonicCondition> conditions;
  conditions.reserve(samples.size());
  for (const auto& sample : samples) {
    conditions.push_back(compute_condition(sample, vehicle, atmosphere_model));
  }

  size_t peak_q_index = 0;
  size_t peak_heat_index = 0;
  size_t impact_index = conditions.size() - 1;
  for (size_t index = 0; index < conditions.size(); ++index) {
    if (conditions[index].dynamicPressurePa > conditions[peak_q_index].dynamicPressurePa) {
      peak_q_index = index;
    }
    if (conditions[index].stagnationHeatFluxWm2 > conditions[peak_heat_index].stagnationHeatFluxWm2) {
      peak_heat_index = index;
    }
    if (conditions[index].sample.altitudeM <= 0.0) {
      impact_index = index;
    }
  }

  const auto& peak_q = conditions[peak_q_index];
  const auto& peak_heat = conditions[peak_heat_index];
  const auto& impact = conditions[impact_index];

  char summary[2048];
  std::snprintf(
    summary,
    sizeof(summary),
    "\"peakDynamicPressure\":{\"sampleId\":%s,\"elapsedSeconds\":%.12g,\"valuePa\":%.12g},"
    "\"peakHeating\":{\"sampleId\":%s,\"elapsedSeconds\":%.12g,\"valueWm2\":%.12g},"
    "\"impactPoint\":{\"sampleId\":%s,\"elapsedSeconds\":%.12g,\"altitudeM\":%.12g,\"speedMps\":%.12g}",
    quote(peak_q.sample.id).c_str(),
    peak_q.sample.elapsedSeconds,
    peak_q.dynamicPressurePa,
    quote(peak_heat.sample.id).c_str(),
    peak_heat.sample.elapsedSeconds,
    peak_heat.stagnationHeatFluxWm2,
    quote(impact.sample.id).c_str(),
    impact.sample.elapsedSeconds,
    impact.sample.altitudeM,
    impact.sample.speedMps);

  std::string response =
    "{\"provider\":\"reentry-analysis\","
    "\"atmosphereProvider\":" + quote(atmosphere_provider) + ","
    "\"hypersonicsProvider\":" + quote(hypersonics_provider) + ","
    "\"atmosphereModel\":" + quote(atmosphere_model) + ","
    "\"outcome\":\"impact\","
    "\"trajectorySamples\":" + trajectory_samples_json(conditions) + "," +
    std::string(summary) + ","
    "\"events\":["
    "{\"event\":\"entry_interface\",\"sampleId\":" + quote(conditions.front().sample.id) + "},"
    "{\"event\":\"peak_dynamic_pressure\",\"sampleId\":" + quote(peak_q.sample.id) + "},"
    "{\"event\":\"impact\",\"sampleId\":" + quote(impact.sample.id) + "}"
    "],"
    "\"assumptions\":[\"sampled-trajectory evaluation\","
    "\"atmosphere provider composed through model selection\","
    "\"hypersonic conditions computed with Sutton-Graves heating\"]}";

  return emit_json("reentry", "REM.fbs", "$REM", response);
}
