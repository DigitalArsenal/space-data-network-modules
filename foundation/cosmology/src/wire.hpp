#pragma once
#include <map>
#include <string>
#include <vector>
#include <initializer_list>
#include <cmath>

namespace cosmology::wire {
constexpr size_t max_samples = 4096;
struct Request {
  std::map<std::string, std::vector<double>> values;
  bool ok = false;
  Request(std::initializer_list<const char*> allowed) {
    if (plugin_get_input_count() != 1) return;
    const auto* frame = plugin_get_input_frame(0);
    if (!frame || !frame->payload || !frame->port_id || std::string(frame->port_id) != "request" ||
        frame->payload_length > 2 * 1024 * 1024) return;
    flatbuffers::Verifier verifier(frame->payload, frame->payload_length);
    if (!VerifyPCEBuffer(verifier)) return;
    const auto* result = GetPCE(frame->payload)->EVALUATION_RESULT();
    if (!result || result->STATUS() != pceResultStatus::OK || !result->SAMPLES() ||
        result->SAMPLES()->size() != 1) return;
    const auto* sample = result->SAMPLES()->Get(0);
    if (!sample->PARAMETER_VALUES()) return;
    for (const auto* v : *sample->PARAMETER_VALUES()) {
      if (!v->PROVIDER_DEFINED_NAME() || v->PARAMETER() != pceParameter::PROVIDER_DEFINED ||
          v->STATUS() != pceResultStatus::OK || !v->VALUES() || v->STRING_VALUE() ||
          v->VALUES()->size() == 0 || v->VALUES()->size() > max_samples) return;
      const std::string name = v->PROVIDER_DEFINED_NAME()->str();
      bool known = false;
      for (const char* candidate : allowed) if (name == candidate) known = true;
      if (!known || values.count(name)) return;
      std::vector<double> vector(v->VALUES()->begin(), v->VALUES()->end());
      for (double number : vector) if (!std::isfinite(number)) return;
      values.emplace(name, std::move(vector));
    }
    ok = true;
  }
  const std::vector<double>& get(const char* name) const {
    static const std::vector<double> empty;
    const auto it = values.find(name);
    return it == values.end() ? empty : it->second;
  }
  bool has(const char* name) const { return values.count(name) != 0; }
  bool length(const char* name, size_t count, bool required = true) const {
    return has(name) ? get(name).size() == count : !required;
  }
};
inline int fail(const char* message) {
  plugin_set_error("invalid-cosmology-request", message);
  return 1;
}
struct Result {
  flatbuffers::FlatBufferBuilder builder{4096};
  std::vector<flatbuffers::Offset<PCEParameterValue>> values;
  std::vector<flatbuffers::Offset<PCEParameterDescriptor>> descriptors;
  void vector(const char* name, const std::vector<double>& value, const char* unit = "1") {
    PCEParameterDescriptorT descriptor;
    descriptor.PARAMETER = pceParameter::PROVIDER_DEFINED;
    descriptor.PROVIDER_DEFINED_NAME = name;
    descriptor.OWNER_CLASS = pceOwnerClass::SOLVER;
    descriptor.DATA_TYPE = pceDataType::REAL_VECTOR;
    descriptor.UNIT = pceUnit::PROVIDER_DEFINED;
    descriptor.PROVIDER_DEFINED_UNIT_SYMBOL = unit;
    descriptor.ELEMENT_COUNT = int(value.size());
    descriptors.push_back(PCEParameterDescriptor::Pack(builder, &descriptor));
    const auto data = builder.CreateVector(value);
    values.push_back(CreatePCEParameterValue(builder, pceParameter::PROVIDER_DEFINED,
      builder.CreateString(name), pceResultStatus::OK, 0, data, 0, 0, 0, pceUnit::PROVIDER_DEFINED));
  }
  int emit() {
    const auto parameters = builder.CreateVector(values);
    const auto sample = CreatePCEParameterSample(builder, 0, 0, parameters);
    const auto samples = builder.CreateVector(std::vector<flatbuffers::Offset<PCEParameterSample>>{sample});
    const auto result = CreatePCEEvaluationResult(builder, pceResultStatus::OK, 0, samples);
    const auto entries = builder.CreateVector(descriptors);
    const auto catalog = CreatePCEParameterCatalog(builder, builder.CreateString("cosmology/0.1"),
      builder.CreateString("com.digitalarsenal.foundation.cosmology"), 0, entries);
    FinishPCEBuffer(builder, CreatePCE(builder, catalog, 0, result));
    return plugin_push_output("result", "PCE.fbs", "$PCE", builder.GetBufferPointer(), builder.GetSize()) < 0 ? 1 : 0;
  }
};
} // namespace cosmology::wire
