namespace {

using namespace provider_node;

constexpr const char* kDefaultSourceUrl =
    "https://www.aiub.unibe.ch/download/CODE/COD0OPSULT.SP3";

uint64_t count_epochs(const std::vector<uint8_t>& bytes) {
  uint64_t count = 0;
  for (const std::string_view line : lines(bytes)) {
    if (!line.empty() && line.front() == '*') ++count;
  }
  return count;
}

}  // namespace

extern "C" int emit(void) {
  plugin_reset_output_state();
  std::string config;
  if (!provider_node::read_config_json(&config)) {
    plugin_set_error("invalid-config", "config must be a valid canonical or aligned FSB");
    return 400;
  }
  std::string source_url = kDefaultSourceUrl;
  std::string configured;
  if (json_string(config, "sourceUrl", &configured) && !configured.empty()) {
    source_url = configured;
  }
  const HttpResult response = http_get(source_url);
  if (response.status != 200 || response.body.empty()) {
    plugin_set_error("ephemeris-fetch", "unable to fetch the complete GLONASS SP3 response");
    return 502;
  }
  if (emit_complete_response(response.body, "SP3", "SP3", count_epochs) < 0) {
    plugin_set_error("output-failed", "unable to emit an FSB chunk");
    return 500;
  }
  return 0;
}
