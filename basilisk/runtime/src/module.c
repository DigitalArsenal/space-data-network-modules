#include <stdint.h>

#include "space_data_module_invoke.h"

int echo_xtc_dictionary(void) {
  const plugin_input_frame_t *frame = plugin_get_input_frame(0);
  if (!frame) {
    plugin_set_error("missing-dictionary", "No XTC dictionary frame was provided.");
    return 3;
  }

  plugin_push_output(
    "dictionary",
    frame->schema_name,
    frame->file_identifier,
    frame->payload,
    frame->payload_length
  );
  return 0;
}
