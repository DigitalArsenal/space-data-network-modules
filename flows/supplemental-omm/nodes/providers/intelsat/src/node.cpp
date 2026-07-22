namespace {

using namespace provider_node;

constexpr const char* kDefaultListingUrl = "https://my.intelsat.com/ephemeris/public";
constexpr const char* kDefaultEphemerisBase =
    "https://my.intelsat.com/Resource/Ephemeris/";
constexpr const char* kDefaultTarget = "is-21";

uint64_t count_epochs(const std::vector<uint8_t>& bytes) {
  uint64_t count = 0;
  for (const std::string_view line : lines(bytes)) {
    if (line.size() >= 11 && line[4] == '/' && line[7] == '/' &&
        line[10] == ' ') {
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
  std::string ephemeris_base = kDefaultEphemerisBase;
  std::string target = kDefaultTarget;
  std::string value;
  if (json_string(config, "listingUrl", &value) && !value.empty()) listing_url = value;
  if (json_string(config, "ephemerisBase", &value) && !value.empty()) ephemeris_base = value;
  if (json_string(config, "target", &value) && !value.empty()) target = value;

  const HttpResult listing = http_get(listing_url);
  if (listing.status != 200 || listing.body.empty()) {
    plugin_set_error("listing-fetch", "unable to fetch the complete Intelsat listing");
    return 502;
  }
  const std::string marker = "_" + target + "_";
  std::string filename = select_newest_filename(listing.body, marker, "_e_");
  if (filename.size() > 4 && filename.compare(filename.size() - 4, 4, ".txt") == 0) {
    filename.resize(filename.size() - 4);
  }
  if (filename.empty()) {
    plugin_set_error("listing-empty", "Intelsat listing contained no configured ECF unit");
    return 422;
  }
  const HttpResult response = http_get(join_url(ephemeris_base, filename + ".txt"));
  if (response.status != 200 || response.body.empty()) {
    plugin_set_error("ephemeris-fetch", "unable to fetch the complete Intelsat ECF response");
    return 502;
  }
  if (emit_complete_response(response.body, "ECF", "ECF", count_epochs) < 0) {
    plugin_set_error("output-failed", "unable to emit a canonical FSB chunk");
    return 500;
  }
  return 0;
}
