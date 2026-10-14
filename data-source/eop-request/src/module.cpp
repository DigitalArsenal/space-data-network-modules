// eop-request: TimerTick -> one HttpRequest (GET the method's file, 90 s, 16 MiB budget) whose CONTEXT is the parser
// job, a size-prefixed $ICN naming the source. No config, no hostcalls.
namespace {
int request(int source) {
  using namespace eop_wire;
  plugin_reset_output_state();
  const plugin_input_frame_t* tick = frame("tick");
  if (!unique_inputs() || !tick || !tick->payload)
    return error("Exactly one timer tick is required.");
  flatbuffers::Verifier verifier(tick->payload, tick->payload_length);
  if (!sdn::runtime::VerifyTimerTickBuffer(verifier))
    return error("The tick is not a TimerTick (TICK).");
  const auto& s = sources[source];
  const std::vector<uint8_t> context = job(s);
  flatbuffers::FlatBufferBuilder b(1024);
  R::FinishHttpRequestBuffer(
      b, R::CreateHttpRequestDirect(b, "GET", s.url, nullptr, nullptr, 90000, 16777216, &context));
  return push_flatbuffer("request", "HttpRequest.fbs", R::HttpRequestIdentifier(), "HttpRequest",
                         b.GetBufferPointer(), b.GetSize()) < 0
             ? 5
             : 0;
}
}  // namespace
extern "C" int finals2000a() { return request(0); }
extern "C" int c04() { return request(1); }
extern "C" int paris() { return request(2); }
