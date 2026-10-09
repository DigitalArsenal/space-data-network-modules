// SDS EOP invoke adapter. Inlined after generated bindings and axis_engine.hpp.
// No new schema: one row, several frames, or a size-prefixed EOP stream. The
// reading and the interpolation rule are eop_series.hpp's, shared with
// propagator/hpop.
#include "eop_series.hpp"
#include <string>
#include <vector>
namespace {
// Empty string = success (including no row); errors are explicit INVALID_INPUT.
std::string read_eop_table(double utc1, double utc2, ax::EarthOrientation* out,
                           const EOP** provenance, bool* supplied) {
  std::vector<ax::eop::Row> rows;
  for (uint32_t i = 0; i < plugin_get_input_count(); ++i) {
    auto frame = plugin_get_input_frame(i);
    if (!frame || !frame->port_id ||
        std::strcmp(frame->port_id, "earth_orientation") != 0)
      continue;
    const std::string error =
        ax::eop::addPayload(frame->payload, frame->payload_length, rows);
    if (!error.empty()) return error;
  }
  if (rows.empty()) return "";
  const std::string error = ax::eop::at(
      rows, utc1, utc2, out, [](const char* date, double mjd) {
        int y, m, d, h, minute;
        double second, jd0, day;
        return parse_iso_utc(date, &y, &m, &d, &h, &minute, &second) && !h &&
               !minute && !second && eraCal2jd(y, m, d, &jd0, &day) == 0 &&
               day == mjd;
      });
  if (!error.empty()) return error;
  *provenance = rows.front().row;
  *supplied = true;
  return "";
}
}  // namespace
