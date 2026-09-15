namespace {
int request(int source) {
  using namespace eop_wire;
  plugin_reset_output_state();
  if (!unique_inputs() || !frame("tick"))
    return error("Exactly one timer tick is required.");
  const auto& s = sources[source];
  if (push("request", {{"method", "GET"},
                       {"url", s.url},
                       {"timeoutMs", 90000},
                       {"maxBytes", 16777216}}) < 0)
    return 5;
  return push("job", {{"source_url", s.url},
                      {"series_name", s.name},
                      {"format", s.format}}) < 0
             ? 5
             : 0;
}
}  // namespace
extern "C" int finals2000a() { return request(0); }
extern "C" int c04() { return request(1); }
extern "C" int paris() { return request(2); }
