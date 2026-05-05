#include "space_data_module_invoke.h"

int solve_lambert(void) {
  plugin_set_error(
    "solver-not-implemented",
    "Lambert solver runtime is not implemented yet; the SDK artifact is a fail-closed shell."
  );
  return 501;
}
