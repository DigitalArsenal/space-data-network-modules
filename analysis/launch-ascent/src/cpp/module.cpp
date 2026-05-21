using namespace sdn_hypersonics;

extern "C" int simulate_launch_ascent(void) {
  plugin_reset_output_state();

  const std::string request = payload_for_port("ascent");
  if (request.empty()) {
    return fail("missing-ascent", "Input port \"ascent\" is required.");
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

  size_t max_q_index = 0;
  size_t max_mach_index = 0;
  for (size_t index = 0; index < conditions.size(); ++index) {
    if (conditions[index].dynamicPressurePa > conditions[max_q_index].dynamicPressurePa) {
      max_q_index = index;
    }
    if (conditions[index].mach > conditions[max_mach_index].mach) {
      max_mach_index = index;
    }
  }

  const auto& max_q = conditions[max_q_index];
  const auto& max_mach = conditions[max_mach_index];
  const auto& first = conditions.front();
  const auto& last = conditions.back();

  char summary[2048];
  std::snprintf(
    summary,
    sizeof(summary),
    "\"maxDynamicPressure\":{\"sampleId\":%s,\"elapsedSeconds\":%.12g,\"valuePa\":%.12g},"
    "\"maxMach\":{\"sampleId\":%s,\"elapsedSeconds\":%.12g,\"value\":%.12g},"
    "\"insertionState\":{\"sampleId\":%s,\"elapsedSeconds\":%.12g,\"altitudeM\":%.12g,\"speedMps\":%.12g}",
    quote(max_q.sample.id).c_str(),
    max_q.sample.elapsedSeconds,
    max_q.dynamicPressurePa,
    quote(max_mach.sample.id).c_str(),
    max_mach.sample.elapsedSeconds,
    max_mach.mach,
    quote(last.sample.id).c_str(),
    last.sample.elapsedSeconds,
    last.sample.altitudeM,
    last.sample.speedMps);

  std::string response =
    "{\"provider\":\"launch-ascent-analysis\","
    "\"atmosphereProvider\":" + quote(atmosphere_provider) + ","
    "\"hypersonicsProvider\":" + quote(hypersonics_provider) + ","
    "\"atmosphereModel\":" + quote(atmosphere_model) + ","
    "\"status\":\"nominal\","
    "\"hypersonicConditions\":" + join_conditions(conditions) + "," +
    std::string(summary) + ","
    "\"events\":["
    "{\"event\":\"liftoff\",\"sampleId\":" + quote(first.sample.id) + "},"
    "{\"event\":\"max_dynamic_pressure\",\"sampleId\":" + quote(max_q.sample.id) + "},"
    "{\"event\":\"ascent_complete\",\"sampleId\":" + quote(last.sample.id) + "}"
    "],"
    "\"assumptions\":[\"sampled-ascent evaluation\","
    "\"atmosphere provider composed through model selection\","
    "\"hypersonic conditions computed with Sutton-Graves heating\"]}";

  return emit_json("launch", "LAM.fbs", "$LAM", response);
}
