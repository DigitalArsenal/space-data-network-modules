namespace {

using namespace provider_node;

constexpr const char* kDefaultListingUrl =
    "https://edc.dgfi.tum.de/pub/slr/cpf_predicts_v2/2026/lageos1/";
constexpr const char* kDefaultTarget = "lageos1";

uint64_t count_epochs(const std::vector<uint8_t>& bytes) {
  uint64_t count = 0;
  for (const std::string_view line : lines(bytes)) {
    if (line.size() > 2 && line[0] == '1' && line[1] == '0' &&
        (line[2] == ' ' || line[2] == '\t')) {
      ++count;
    }
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
  std::string listing_url = kDefaultListingUrl;
  std::string target = kDefaultTarget;
  std::string value;
  if (json_string(config, "listingUrl", &value) && !value.empty()) listing_url = value;
  if (json_string(config, "target", &value) && !value.empty()) target = value;

  const HttpResult listing = http_get(listing_url);
  if (listing.status != 200 || listing.body.empty()) {
    plugin_set_error("listing-fetch", "unable to fetch the complete CPF listing");
    return 502;
  }
  const std::string filename =
      select_newest_filename(listing.body, target + "_cpf_");
  if (filename.empty()) {
    plugin_set_error("listing-empty", "CPF listing contained no configured fetch unit");
    return 422;
  }
  const HttpResult response = http_get(join_url(listing_url, filename));
  if (response.status != 200 || response.body.empty()) {
    plugin_set_error("ephemeris-fetch", "unable to fetch the complete CPF response");
    return 502;
  }
  if (emit_complete_response(response.body, "CPF", "CPF", count_epochs) < 0) {
    plugin_set_error("output-failed", "unable to emit a canonical FSB chunk");
    return 500;
  }
  return 0;
}
