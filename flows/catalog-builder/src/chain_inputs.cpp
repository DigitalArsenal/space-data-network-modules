#include "space_data_module_invoke.h"
#include <vector>
#include <string>
#include <cstring>

// The adapter calls the propagator's unchanged methods with isolated inputs and
// outputs. A refused fit cannot leak partial candidates into the product stream.
namespace catalog_chain {
struct Output { std::string port; std::vector<uint8_t> bytes; };
static std::vector<plugin_input_frame_t> inputs;
static std::vector<Output> outputs;
static std::string error_code, error_message;
static size_t output_bytes = 0;
static uint32_t input_count() { return inputs.size(); }
static const plugin_input_frame_t* input_frame(uint32_t i) { return i < inputs.size() ? &inputs[i] : nullptr; }
static void reset() { outputs.clear(); output_bytes = 0; error_code.clear(); error_message.clear(); }
static void error(const char* code, const char* message) {
  error_code = code ? code : ""; error_message = message ? message : "";
}
static int32_t push(const char* port, const char*, const char*, const uint8_t* bytes, uint32_t size) {
  if (size > 16 * 1024 * 1024 - output_bytes) { error("chain-output-bound", "Chain outputs exceed 16 MiB."); return -1; }
  outputs.push_back({port, {bytes, bytes + size}}); output_bytes += size; return 0;
}
static void input(const char* port, const plugin_input_frame_t* original) {
  auto f = *original; f.port_id = port; inputs.push_back(f);
}
static void input(const char* port, const uint8_t* bytes, size_t size) {
  plugin_input_frame_t f{}; f.port_id = port; f.payload = bytes; f.payload_length = size; f.size = size; inputs.push_back(f);
}
static std::vector<uint8_t> take(const char* port) {
  for (auto& output : outputs) if (output.port == port) return std::move(output.bytes);
  return {};
}
}
#define plugin_get_input_count catalog_chain::input_count
#define plugin_get_input_frame catalog_chain::input_frame
#define plugin_reset_output_state catalog_chain::reset
#define plugin_push_output catalog_chain::push
#define plugin_set_error catalog_chain::error
