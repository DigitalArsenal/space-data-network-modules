// The SDK owns PIV validation, allocation, manifest exports, and command framing.
// Reuse the ACW evaluator above; all geometry remains in access_plugin.cpp.
#include "space_data_module_invoke.h"

extern "C" int compute_access_windows(void) {
  const int32_t index = plugin_find_input_index("request", 0);
  const auto* frame = index >= 0 ? plugin_get_input_frame(index) : nullptr;
  if (!frame) {
    plugin_set_error("missing-access-request", "ACW request frame is required.");
    return 400;
  }
  const auto bytes = dispatchAcwInput({frame->payload, frame->payload_length}, 0);
  const auto* response = GetPIV(bytes.data())->RESPONSE();
  if (response->STATUS_CODE() != 0) {
    plugin_set_error(response->ERROR_CODE()->c_str(), response->ERROR_MESSAGE()->c_str());
    return response->STATUS_CODE();
  }
  const auto* arena = response->PAYLOAD_ARENA();
  const auto* output = response->OUTPUTS()->Get(0);
  return plugin_push_output_typed(
      "results", "ACW.fbs", "$ACW", PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER,
      "ACW", 0, 0, 0, arena->data() + output->OFFSET(), output->SIZE());
}
