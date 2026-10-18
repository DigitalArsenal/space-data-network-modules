#pragma once
#include <cstdint>
#include <cstdio>
#include <string>
#include <vector>

// One $PCE row of provider-defined parameters, appended size-prefixed to an
// SDS stream, and the ISO 8601 UTC stamp of a retrieval.
namespace {
struct Row {
  flatbuffers::FlatBufferBuilder b{1u << 20};
  std::vector<flatbuffers::Offset<PCEParameterValue>> values;
  std::vector<flatbuffers::Offset<PCEParameterDescriptor>> descriptors;
  void describe(const char* name, pceDataType type, const char* unit, int count = 1) {
    PCEParameterDescriptorT d;
    d.PARAMETER = pceParameter::PROVIDER_DEFINED; d.PROVIDER_DEFINED_NAME = name;
    d.OWNER_CLASS = pceOwnerClass::SOLVER; d.DATA_TYPE = type;
    d.UNIT = pceUnit::PROVIDER_DEFINED; d.PROVIDER_DEFINED_UNIT_SYMBOL = unit; d.ELEMENT_COUNT = count;
    descriptors.push_back(PCEParameterDescriptor::Pack(b, &d));
  }
  void number(const char* name, double value, const char* unit = "1") {
    describe(name, pceDataType::REAL_SCALAR, unit);
    values.push_back(CreatePCEParameterValue(b, pceParameter::PROVIDER_DEFINED, b.CreateString(name),
                                             pceResultStatus::OK, value, 0, 0, 0, 0, pceUnit::PROVIDER_DEFINED));
  }
  void vector(const char* name, const std::vector<double>& value, const char* unit = "1") {
    describe(name, pceDataType::REAL_VECTOR, unit, int(value.size()));
    const auto data = b.CreateVector(value);
    values.push_back(CreatePCEParameterValue(b, pceParameter::PROVIDER_DEFINED, b.CreateString(name),
                                             pceResultStatus::OK, 0, data, 0, 0, 0, pceUnit::PROVIDER_DEFINED));
  }
  void text(const char* name, const std::string& value) {
    describe(name, pceDataType::STRING, "text");
    const auto s = b.CreateString(value);
    values.push_back(CreatePCEParameterValue(b, pceParameter::PROVIDER_DEFINED, b.CreateString(name),
                                             pceResultStatus::OK, 0, 0, 0, 0, s, pceUnit::PROVIDER_DEFINED));
  }
  void finish(std::vector<uint8_t>& stream) {
    const auto params = b.CreateVector(values);
    const auto sample = CreatePCEParameterSample(b, 0, 0, params);
    const auto samples = b.CreateVector(std::vector<flatbuffers::Offset<PCEParameterSample>>{sample});
    const auto result = CreatePCEEvaluationResult(b, pceResultStatus::OK, 0, samples);
    const auto entries = b.CreateVector(descriptors);
    const auto catalog = CreatePCEParameterCatalog(b, b.CreateString("dust-map-3d/0.1"),
                                                   b.CreateString("com.digitalarsenal.data-source.dust-map-3d"), 0, entries);
    FinishSizePrefixedPCEBuffer(b, CreatePCE(b, catalog, 0, result));
    stream.insert(stream.end(), b.GetBufferPointer(), b.GetBufferPointer() + b.GetSize());
  }
};

std::string isoTime(int64_t ms) {
  const int64_t sec = ms / 1000, day = sec / 86400, rem = sec % 86400;
  const int64_t z = day + 719468, era = (z >= 0 ? z : z - 146096) / 146097;
  const unsigned doe = unsigned(z - era * 146097), yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
  const unsigned doy = doe - (365 * yoe + yoe / 4 - yoe / 100), mp = (5 * doy + 2) / 153;
  const unsigned dd = doy - (153 * mp + 2) / 5 + 1, mm = mp < 10 ? mp + 3 : mp - 9;
  const int64_t yy = int64_t(yoe) + era * 400 + (mm <= 2);
  char when[32];
  std::snprintf(when, sizeof when, "%04lld-%02u-%02uT%02lld:%02lld:%02lldZ", (long long)yy, mm, dd,
                (long long)(rem / 3600), (long long)(rem % 3600 / 60), (long long)(rem % 60));
  return when;
}

}  // namespace
