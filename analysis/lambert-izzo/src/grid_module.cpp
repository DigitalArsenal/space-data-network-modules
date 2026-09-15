#ifndef LAMBERT_IZZO_GRID_HPP
#include "lambert_izzo/grid.hpp"
#endif
#include <map>

namespace {
using GridValue = flatbuffers::Offset<PCEParameterValue>;
using GridValues = std::map<std::string, const PCEParameterValue*>;
const PCEParameterValue* grid_value(const GridValues& values, const std::string& name,
                                   pceUnit unit, bool vector) {
  const auto it = values.find(name);
  if (it == values.end()) return nullptr;
  const auto* v = it->second;
  if (v->STATUS() != pceResultStatus_OK || v->UNIT() != unit ||
      bool(v->VALUES()) != vector || v->STRING_VALUE()) return nullptr;
  return v;
}
bool grid_scalar(const GridValues& values, const char* name, pceUnit unit, double& out) {
  const auto* v = grid_value(values, name, unit, false);
  if (!v || !std::isfinite(v->VALUE())) return false;
  out = v->VALUE(); return true;
}
bool grid_states(const GridValues& values, const char* prefix,
                 std::vector<lambert_grid::State>& out) {
  const std::string p(prefix);
  const auto* t = grid_value(values, p + "_epochs", pceUnit_SECOND, true);
  const auto* r = grid_value(values, p + "_positions", pceUnit_METRE, true);
  const auto* v = grid_value(values, p + "_velocities", pceUnit_METRE_PER_SECOND, true);
  if (!t || !r || !v) return false;
  const size_t n = t->VALUES()->size();
  if (n == 0 || n > lambert_grid::kMaxAxis || r->VALUES()->size() != 3*n ||
      v->VALUES()->size() != 3*n || r->ROW_COUNT() != static_cast<int>(n) ||
      v->ROW_COUNT() != static_cast<int>(n) || r->COLUMN_COUNT() != 3 ||
      v->COLUMN_COUNT() != 3) return false;
  out.resize(n);
  for (size_t i = 0; i < n; ++i) {
    out[i] = {t->VALUES()->Get(i),
        {r->VALUES()->Get(3*i)/1000, r->VALUES()->Get(3*i+1)/1000, r->VALUES()->Get(3*i+2)/1000},
        {v->VALUES()->Get(3*i)/1000, v->VALUES()->Get(3*i+1)/1000, v->VALUES()->Get(3*i+2)/1000}};
  }
  return true;
}
int grid_error(const char* message) {
  plugin_set_error("invalid-grid-request", message); return 1;
}
GridValue grid_number(flatbuffers::FlatBufferBuilder& b, const char* name, double value,
                      pceUnit unit = pceUnit_DIMENSIONLESS) {
  return CreatePCEParameterValue(b, pceParameter_PROVIDER_DEFINED, b.CreateString(name),
      pceResultStatus_OK, value, 0, 0, 0, 0, unit);
}
int emit_grid(const char* port, const std::vector<lambert_grid::Cell>& row,
              int row_index, int column_index, const PCEEvaluationContext& context,
              const std::string& trace) {
  flatbuffers::FlatBufferBuilder b(4096);
  std::vector<GridValue> values;
  values.push_back(grid_number(b, "departure_index", row_index));
  if (column_index != -2) values.push_back(grid_number(b, "arrival_index", column_index));
  auto vector = [&](const char* name, pceUnit unit, auto getter) {
    std::vector<double> data; data.reserve(row.size());
    for (const auto& cell : row) data.push_back(getter(cell));
    const auto data_offset = b.CreateVector(data);
    values.push_back(CreatePCEParameterValue(b, pceParameter_PROVIDER_DEFINED, b.CreateString(name),
        pceResultStatus_OK, 0, data_offset, 0, 0, 0, unit));
  };
  vector("departure_epoch", pceUnit_SECOND, [](const auto& c){return c.departure_epoch;});
  vector("arrival_epoch", pceUnit_SECOND, [](const auto& c){return c.arrival_epoch;});
  vector("tof", pceUnit_SECOND, [](const auto& c){return c.tof;});
  vector("departure_dv", pceUnit_METRE_PER_SECOND, [](const auto& c){return c.departure_dv*1000;});
  vector("arrival_dv", pceUnit_METRE_PER_SECOND, [](const auto& c){return c.arrival_dv*1000;});
  vector("total_dv", pceUnit_METRE_PER_SECOND, [](const auto& c){return c.total_dv*1000;});
  vector("departure_c3", pceUnit_METRE_SQUARED_PER_SECOND_SQUARED,
      [](const auto& c){return c.departure_dv*c.departure_dv*1e6;});
  vector("status", pceUnit_DIMENSIONLESS, [](const auto& c){return double(c.status);});
  vector("revolutions", pceUnit_DIMENSIONLESS, [](const auto& c){return double(c.revolutions);});
  vector("branch", pceUnit_DIMENSIONLESS, [](const auto& c){return double(c.branch);});
  vector("direction", pceUnit_DIMENSIONLESS, [](const auto& c){return double(c.direction);});
  for (int end = 0; end < 2; ++end) {
    std::vector<double> data; data.reserve(row.size()*3);
    for (const auto& cell : row) {
      const auto& v = end ? cell.v2 : cell.v1;
      const double nan = std::numeric_limits<double>::quiet_NaN();
      data.insert(data.end(), {cell.status ? nan : v.x*1000, cell.status ? nan : v.y*1000,
                              cell.status ? nan : v.z*1000});
    }
    const auto data_offset = b.CreateVector(data);
    values.push_back(CreatePCEParameterValue(b, pceParameter_PROVIDER_DEFINED,
        b.CreateString(end ? "transfer_arrival_velocity" : "transfer_departure_velocity"),
        pceResultStatus_OK, 0, data_offset, static_cast<int>(row.size()), 3, 0, pceUnit_METRE_PER_SECOND));
  }
  const auto frame_name = b.CreateString(context.DEFAULT_COORDINATE_SYSTEM_NAME()->str());
  values.push_back(CreatePCEParameterValue(b, pceParameter_PROVIDER_DEFINED,
      b.CreateString("reference_frame"), pceResultStatus_OK, 0, 0, 0, 0, frame_name));
  const auto value_offsets = b.CreateVector(values);
  const auto epoch = b.CreateString(context.REFERENCE_EPOCH()->str());
  const auto time = b.CreateString(context.DEFAULT_TIME_SYSTEM()->str());
  const auto sample = CreatePCEParameterSample(b, epoch, time, value_offsets);
  const auto samples = b.CreateVector(std::vector<flatbuffers::Offset<PCEParameterSample>>{sample});
  const auto result = CreatePCEEvaluationResult(b, pceResultStatus_OK, 0, samples, 0, b.CreateString(trace));
  const auto record = CreatePCE(b, 0, 0, result);
  FinishPCEBuffer(b, record);
  return plugin_push_output(port, "PCE.fbs", "$PCE", b.GetBufferPointer(), b.GetSize());
}
} // namespace

extern "C" int grid_search(void) {
  const plugin_input_frame_t* frame = find_request_frame();
  if (!frame || !frame->payload || frame->payload_length > 256*1024)
    return grid_error("Expected one PCE grid request of at most 256 KiB.");
  flatbuffers::Verifier verifier(frame->payload, frame->payload_length);
  if (!VerifyPCEBuffer(verifier)) return grid_error("Invalid PCE FlatBuffer.");
  const auto* request = GetPCE(frame->payload);
  const auto* er = request->EVALUATION_REQUEST();
  const auto* context = er ? er->CONTEXT() : nullptr;
  if (!context || !context->DEFAULT_COORDINATE_SYSTEM_NAME() ||
      context->DEFAULT_COORDINATE_SYSTEM_NAME()->size() == 0 ||
      !context->REFERENCE_EPOCH() || context->REFERENCE_EPOCH()->size() == 0 ||
      !context->DEFAULT_TIME_SYSTEM())
    return grid_error("Provide inertial frame, reference epoch and continuous time scale in CONTEXT.");
  const std::string time = context->DEFAULT_TIME_SYSTEM()->str();
  if (time != "TT" && time != "TDB" && time != "TAI")
    return grid_error("Epoch offsets must use TT, TDB or TAI seconds, not civil UTC.");
  const auto* result = request->EVALUATION_RESULT();
  if (!result || result->STATUS() != pceResultStatus_OK || !result->SAMPLES() ||
      result->SAMPLES()->size() != 1 || !result->SAMPLES()->Get(0)->PARAMETER_VALUES())
    return grid_error("Expected one PCE sample containing grid parameters.");
  GridValues values;
  for (const auto* value : *result->SAMPLES()->Get(0)->PARAMETER_VALUES()) {
    if (value->PARAMETER() != pceParameter_PROVIDER_DEFINED || !value->PROVIDER_DEFINED_NAME() ||
        !values.emplace(value->PROVIDER_DEFINED_NAME()->str(), value).second)
      return grid_error("Grid parameter names must be unique PROVIDER_DEFINED entries.");
  }
  if (values.size() != 13) return grid_error("Expected exactly the 13 documented grid parameters.");
  lambert_grid::Options options{};
  double revs, flags;
  if (!grid_scalar(values, "departure_start", pceUnit_SECOND, options.departure_start) ||
      !grid_scalar(values, "departure_end", pceUnit_SECOND, options.departure_end) ||
      !grid_scalar(values, "arrival_start", pceUnit_SECOND, options.arrival_start) ||
      !grid_scalar(values, "arrival_end", pceUnit_SECOND, options.arrival_end) ||
      !grid_scalar(values, "grid_step", pceUnit_SECOND, options.step) ||
      !grid_scalar(values, "max_revolutions", pceUnit_DIMENSIONLESS, revs) ||
      !grid_scalar(values, "direction_flags", pceUnit_DIMENSIONLESS, flags) ||
      revs < 0 || revs > 32 || std::floor(revs) != revs || flags < 1 || flags > 3 || std::floor(flags) != flags)
    return grid_error("Invalid grid controls, units, revolution budget or direction flags.");
  options.max_revolutions = static_cast<uint16_t>(revs);
  options.prograde = static_cast<int>(flags)&1; options.retrograde = static_cast<int>(flags)&2;
  options.mu = context->GRAVITATIONAL_PARAMETER()/1e9;
  std::vector<lambert_grid::State> departure, arrival;
  if (!grid_states(values, "departure", departure) || !grid_states(values, "arrival", arrival))
    return grid_error("Each ephemeris requires 1..400 epochs and N-by-3 positions/velocities in SI units.");
  const std::string trace = er->TRACE_ID() ? er->TRACE_ID()->str() : "lambert-grid";
  lambert_grid::Cell best; int best_row, best_column, last_frame = -1; uint64_t last_sequence = 0;
  bool emit_failed = false;
  const bool ok = lambert_grid::search(departure, arrival, options,
      [&](size_t i, const auto& row) {
        last_frame = emit_grid("mesh", row, i, -2, *context, trace);
        last_sequence = i;
        if (last_frame < 0) { emit_failed = true; return false; }
        plugin_set_output_stream_frame(last_frame, i, 0);
        return true;
      }, best, best_row, best_column);
  if (!ok) {
    plugin_reset_output_state();
    if (emit_failed) { plugin_set_error("emit-failed", "Unable to emit mesh row."); return 1; }
    return grid_error("Invalid mu, unordered/nonfinite states, missing grid epochs, or axis exceeds 400 cells.");
  }
  plugin_set_output_stream_frame(last_frame, last_sequence, 1);
  const int summary = emit_grid("best", best_row < 0 ? std::vector<lambert_grid::Cell>{} :
      std::vector<lambert_grid::Cell>{best}, best_row, best_column, *context, trace);
  if (summary < 0) { plugin_reset_output_state(); plugin_set_error("emit-failed", "Unable to emit best cell."); return 1; }
  plugin_set_output_stream_frame(summary, 0, 1);
  return 0;
}
