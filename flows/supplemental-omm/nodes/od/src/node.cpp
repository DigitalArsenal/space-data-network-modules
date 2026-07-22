#include "space_data_module_invoke.h"

#include <algorithm>
#include <cctype>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <iterator>
#include <map>
#include <string>
#include <utility>
#include <vector>

#include <flatbuffers/flatbuffers.h>

#include "FSB/main_generated.h"
#include "OEM_generated.h"
#include "FSB/main_aligned.h"
#include "FSO/main_FSO.h"
#include "od_batch_fit.hpp"
#include "oem_fb_builder.hpp"
#include "result_schema_idl.h"
#include "sds_cid.hpp"

namespace {

constexpr const char* kFsbSchemaName = "FSB.fbs";
constexpr const char* kFsbFileIdentifier = "$FSB";
constexpr const char* kFsbRootType = "FSB";
constexpr uint32_t kFsbAlignedSize = 1'048'744;
constexpr uint16_t kFsbAlignment = 8;
constexpr size_t kFsbDataCapacity = 1'048'576;
constexpr size_t kMaxOutputStreamBytes = 128u * 1024u * 1024u;
constexpr const char* kFsoSchemaName = "FSO.fbs";
constexpr const char* kFsoFileIdentifier = "$FSO";
constexpr const char* kFsoRootType = "FSO";
constexpr uint32_t kFsoAlignedSize = 361'648;
constexpr uint16_t kFsoAlignment = 8;
constexpr uint32_t kAlignedFsoDatabaseOffset = 16;
constexpr uint32_t kAlignedFsoSchemaOffset = 148;
constexpr uint32_t kAlignedFsoBindingsOffset = 262'296;
constexpr uint32_t kAlignedFsoBindingStride = 135;
constexpr size_t kMaxNativeResponseBytes = 64u * 1024u * 1024u;

enum class Provider : uint8_t {
  Starlink,
  Glonass,
  Intelsat,
  Cpf,
  Iss,
};

struct ProviderPort {
  const char* port_id;
  Provider provider;
};

constexpr ProviderPort kProviderPorts[] = {
    {"starlink", Provider::Starlink},
    {"glonass", Provider::Glonass},
    {"intelsat", Provider::Intelsat},
    {"cpf", Provider::Cpf},
    {"iss", Provider::Iss},
};

struct Chunk {
  uint64_t request_id = 0;
  uint32_t sequence = 0;
  bool final = false;
  uint64_t total_bytes = 0;
  uint64_t record_count = 0;
  std::string schema_name;
  std::string file_identifier;
  std::vector<uint8_t> data;
  std::vector<uint8_t> sha256;
  uint32_t wire_format = PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER;
};

struct AssemblyKey {
  Provider provider;
  uint64_t request_id;

  bool operator<(const AssemblyKey& other) const {
    if (provider != other.provider) {
      return static_cast<uint8_t>(provider) <
             static_cast<uint8_t>(other.provider);
    }
    return request_id < other.request_id;
  }
};

struct Assembly {
  uint32_t next_sequence = 0;
  uint64_t total_bytes = 0;
  uint64_t record_count = 0;
  uint32_t wire_format = PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER;
  std::string schema_name;
  std::string file_identifier;
  std::vector<uint8_t> sha256;
  std::vector<uint8_t> bytes;
};

struct RecordStreamAccumulator {
  const char* port_id = nullptr;
  const char* schema_name = nullptr;
  const char* file_identifier = nullptr;
  uint32_t wire_format = PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER;
  uint64_t record_count = 0;
  std::vector<uint8_t> data;
};

struct NativeState {
  std::string epoch;
  double x = 0.0;
  double y = 0.0;
  double z = 0.0;
  double vx = 0.0;
  double vy = 0.0;
  double vz = 0.0;
};

struct ParsedBatch {
  std::vector<od::BatchObject> objects;
  uint32_t wire_format = PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER;
};

std::map<AssemblyKey, Assembly> g_assemblies;
alignas(8) Aligned::FSB g_aligned_output{};
alignas(8) uint8_t g_aligned_control[kFsoAlignedSize]{};
uint64_t g_output_request_id = 1;

std::string trim(const std::string& input) {
  const size_t start = input.find_first_not_of(" \t\r\n");
  if (start == std::string::npos) return {};
  const size_t end = input.find_last_not_of(" \t\r\n");
  return input.substr(start, end - start + 1);
}

std::vector<std::string> split_ws(const std::string& line) {
  std::vector<std::string> tokens;
  size_t cursor = 0;
  while (cursor < line.size()) {
    while (cursor < line.size() &&
           std::isspace(static_cast<unsigned char>(line[cursor]))) {
      ++cursor;
    }
    const size_t start = cursor;
    while (cursor < line.size() &&
           !std::isspace(static_cast<unsigned char>(line[cursor]))) {
      ++cursor;
    }
    if (cursor > start) tokens.push_back(line.substr(start, cursor - start));
  }
  return tokens;
}

template <typename Callback>
void for_each_line(const std::string& content, Callback callback) {
  size_t cursor = 0;
  while (cursor <= content.size()) {
    const size_t newline = content.find('\n', cursor);
    const size_t end = newline == std::string::npos ? content.size() : newline;
    callback(content.substr(cursor, end - cursor));
    if (newline == std::string::npos) break;
    cursor = newline + 1;
  }
}

void append_two_digits(std::string* output, int value) {
  output->push_back(static_cast<char>('0' + ((value / 10) % 10)));
  output->push_back(static_cast<char>('0' + (value % 10)));
}

std::string calendar_iso(int year, int month, int day, int hour, int minute,
                         double seconds) {
  int whole_seconds = static_cast<int>(seconds);
  int millis = static_cast<int>((seconds - whole_seconds) * 1000.0 + 0.5);
  if (millis >= 1000) {
    ++whole_seconds;
    millis -= 1000;
  }
  char buffer[48];
  std::snprintf(buffer, sizeof(buffer),
                "%04d-%02d-%02dT%02d:%02d:%02d.%03dZ", year, month, day,
                hour, minute, whole_seconds, millis);
  return buffer;
}

std::string day_of_year_iso(int year, int day_of_year, int hour, int minute,
                            double seconds) {
  const bool leap =
      (year % 4 == 0 && year % 100 != 0) || (year % 400 == 0);
  const int month_days[] = {31, leap ? 29 : 28, 31, 30, 31, 30,
                            31, 31, 30, 31, 30, 31};
  int month = 1;
  int day = day_of_year;
  while (month <= 12 && day > month_days[month - 1]) {
    day -= month_days[month - 1];
    ++month;
  }
  if (month > 12 || day <= 0) return {};
  return calendar_iso(year, month, day, hour, minute, seconds);
}

std::string meme_epoch_iso(const std::string& token) {
  if (token.size() < 13) return {};
  for (size_t index = 0; index < 13; ++index) {
    if (!std::isdigit(static_cast<unsigned char>(token[index]))) return {};
  }
  const int year = std::strtol(token.substr(0, 4).c_str(), nullptr, 10);
  const int day = std::strtol(token.substr(4, 3).c_str(), nullptr, 10);
  const int hour = std::strtol(token.substr(7, 2).c_str(), nullptr, 10);
  const int minute = std::strtol(token.substr(9, 2).c_str(), nullptr, 10);
  const double seconds = std::strtod(token.substr(11).c_str(), nullptr);
  return day_of_year_iso(year, day, hour, minute, seconds);
}

std::string julian_iso(double julian_date) {
  const double shifted = julian_date + 0.5;
  const int z = static_cast<int>(shifted);
  const double fraction = shifted - static_cast<double>(z);
  int a = z;
  if (z >= 2299161) {
    const int alpha = static_cast<int>((z - 1867216.25) / 36524.25);
    a = z + 1 + alpha - alpha / 4;
  }
  const int b = a + 1524;
  const int c = static_cast<int>((b - 122.1) / 365.25);
  const int d = static_cast<int>(365.25 * c);
  const int e = static_cast<int>((b - d) / 30.6001);
  const int day = b - d - static_cast<int>(30.6001 * e);
  const int month = e < 14 ? e - 1 : e - 13;
  const int year = month > 2 ? c - 4716 : c - 4715;
  const double hours_value = fraction * 24.0;
  const int hour = static_cast<int>(hours_value);
  const double minutes_value = (hours_value - hour) * 60.0;
  const int minute = static_cast<int>(minutes_value);
  const double seconds = (minutes_value - minute) * 60.0;
  return calendar_iso(year, month, day, hour, minute, seconds);
}

std::string normalize_iss_epoch(std::string value) {
  value = trim(value);
  if (!value.empty() && value.back() != 'Z') value.push_back('Z');
  return value;
}

bool parse_starlink_identity(const std::string& schema_name,
                             uint32_t* norad,
                             std::string* object_name) {
  constexpr const char* prefix = "MEME:";
  if (schema_name.compare(0, std::strlen(prefix), prefix) != 0) return false;
  const size_t id_start = std::strlen(prefix);
  const size_t separator = schema_name.find(':', id_start);
  if (separator == std::string::npos) return false;
  *norad = static_cast<uint32_t>(
      std::strtoul(schema_name.substr(id_start, separator - id_start).c_str(),
                   nullptr, 10));
  *object_name = schema_name.substr(separator + 1);
  return *norad != 0 && !object_name->empty();
}

std::vector<uint8_t> build_custom_oem(const std::string& object_name,
                                      const std::string& object_id,
                                      uint32_t norad,
                                      CustomFrame frame,
                                      timingStandard time_system,
                                      const std::vector<NativeState>& states) {
  if (states.size() < 3) return {};
  const oem_fb::Identity identity{object_name.c_str(), object_id.c_str(), norad};
  return oem_fb::build_oem_flatbuffer(
      identity, frame, "EARTH", time_system, states.data(),
      static_cast<int>(states.size()));
}

std::vector<uint8_t> build_celestial_oem(
    const std::string& object_name, const std::string& object_id,
    uint32_t norad, CelestialFrame frame, timingStandard time_system,
    const std::vector<NativeState>& states) {
  if (states.size() < 3) return {};
  const oem_fb::Identity identity{object_name.c_str(), object_id.c_str(), norad};
  return oem_fb::build_oem_flatbuffer(
      identity, frame, "EARTH", time_system, states.data(),
      static_cast<int>(states.size()));
}

std::vector<od::BatchObject> parse_starlink_meme(
    const std::string& content, const std::string& schema_name) {
  uint32_t norad = 0;
  std::string object_name = "STARLINK";
  parse_starlink_identity(schema_name, &norad, &object_name);
  std::vector<NativeState> states;
  for_each_line(content, [&](const std::string& line) {
    const std::vector<std::string> tokens = split_ws(line);
    if (tokens.size() < 7) return;
    const std::string epoch = meme_epoch_iso(tokens[0]);
    if (epoch.empty()) return;
    NativeState state;
    state.epoch = epoch;
    state.x = std::strtod(tokens[1].c_str(), nullptr);
    state.y = std::strtod(tokens[2].c_str(), nullptr);
    state.z = std::strtod(tokens[3].c_str(), nullptr);
    state.vx = std::strtod(tokens[4].c_str(), nullptr);
    state.vy = std::strtod(tokens[5].c_str(), nullptr);
    state.vz = std::strtod(tokens[6].c_str(), nullptr);
    states.push_back(std::move(state));
  });
  std::vector<uint8_t> oem = build_custom_oem(
      object_name, "", norad, CustomFrame::TEME, timingStandard::UTC, states);
  if (oem.empty()) return {};
  return {{std::move(oem)}};
}

std::vector<od::BatchObject> parse_glonass_sp3(const std::string& content) {
  struct Satellite {
    std::string id;
    std::vector<NativeState> states;
  };
  std::vector<Satellite> satellites;
  std::string epoch;
  for_each_line(content, [&](const std::string& line) {
    const std::vector<std::string> tokens = split_ws(line);
    if (tokens.empty()) return;
    if (tokens[0] == "*" && tokens.size() >= 7) {
      epoch = calendar_iso(
          std::strtol(tokens[1].c_str(), nullptr, 10),
          std::strtol(tokens[2].c_str(), nullptr, 10),
          std::strtol(tokens[3].c_str(), nullptr, 10),
          std::strtol(tokens[4].c_str(), nullptr, 10),
          std::strtol(tokens[5].c_str(), nullptr, 10),
          std::strtod(tokens[6].c_str(), nullptr));
      return;
    }
    if (tokens[0].size() < 3 || tokens[0][0] != 'P' ||
        tokens[0][1] != 'R' || tokens.size() < 4 || epoch.empty()) {
      return;
    }
    const std::string id = tokens[0].substr(1);
    Satellite* satellite = nullptr;
    for (Satellite& candidate : satellites) {
      if (candidate.id == id) {
        satellite = &candidate;
        break;
      }
    }
    if (!satellite) {
      satellites.push_back({id, {}});
      satellite = &satellites.back();
    }
    NativeState state;
    state.epoch = epoch;
    state.x = std::strtod(tokens[1].c_str(), nullptr);
    state.y = std::strtod(tokens[2].c_str(), nullptr);
    state.z = std::strtod(tokens[3].c_str(), nullptr);
    if (state.x != 0.0 || state.y != 0.0 || state.z != 0.0) {
      satellite->states.push_back(std::move(state));
    }
  });
  std::vector<od::BatchObject> objects;
  for (const Satellite& satellite : satellites) {
    std::vector<uint8_t> oem = build_custom_oem(
        "GLONASS " + satellite.id, "", 0, CustomFrame::ECEF,
        timingStandard::GPS, satellite.states);
    if (!oem.empty()) objects.push_back({std::move(oem)});
  }
  return objects;
}

std::vector<od::BatchObject> parse_intelsat_ecf(const std::string& content) {
  std::string object_name = "INTELSAT";
  std::vector<NativeState> states;
  bool first_line = true;
  for_each_line(content, [&](const std::string& line) {
    if (first_line) {
      first_line = false;
      const std::string marker = "Intelsat ";
      const size_t start = line.find(marker);
      if (start != std::string::npos) {
        const size_t name_start = start + marker.size();
        const size_t name_end = line.find_first_of(" \t/", name_start);
        object_name = line.substr(name_start, name_end - name_start);
      }
      return;
    }
    const std::vector<std::string> tokens = split_ws(line);
    if (tokens.size() < 5 || tokens[0].size() < 10 || tokens[0][4] != '/' ||
        tokens[0][7] != '/') {
      return;
    }
    NativeState state;
    state.epoch = tokens[0];
    std::replace(state.epoch.begin(), state.epoch.end(), '/', '-');
    state.epoch += "T" + tokens[1] + "Z";
    state.x = std::strtod(tokens[2].c_str(), nullptr) / 1000.0;
    state.y = std::strtod(tokens[3].c_str(), nullptr) / 1000.0;
    state.z = std::strtod(tokens[4].c_str(), nullptr) / 1000.0;
    states.push_back(std::move(state));
  });
  std::vector<uint8_t> oem = build_custom_oem(
      object_name, "", 0, CustomFrame::ECEF, timingStandard::UTC, states);
  if (oem.empty()) return {};
  return {{std::move(oem)}};
}

std::vector<od::BatchObject> parse_cpf(const std::string& content) {
  std::string object_name = "CPF OBJECT";
  std::string object_id;
  uint32_t norad = 0;
  long frame_code = 0;
  std::vector<NativeState> states;
  for_each_line(content, [&](const std::string& line) {
    const std::vector<std::string> tokens = split_ws(line);
    if (tokens.empty()) return;
    if (tokens[0] == "H1" && tokens.size() >= 11) {
      object_name = tokens[10];
      return;
    }
    if (tokens[0] == "H2") {
      if (tokens.size() >= 4) {
        object_id = tokens[1];
        norad = static_cast<uint32_t>(
            std::strtoul(tokens[3].c_str(), nullptr, 10));
      }
      if (tokens.size() >= 20) {
        frame_code = std::strtol(tokens[19].c_str(), nullptr, 10);
      }
      return;
    }
    if (tokens[0] != "10" || tokens.size() < 8) return;
    const long mjd = std::strtol(tokens[2].c_str(), nullptr, 10);
    const double seconds = std::strtod(tokens[3].c_str(), nullptr);
    NativeState state;
    state.epoch = julian_iso(static_cast<double>(mjd) + 2'400'000.5 +
                             seconds / 86'400.0);
    state.x = std::strtod(tokens[5].c_str(), nullptr) / 1000.0;
    state.y = std::strtod(tokens[6].c_str(), nullptr) / 1000.0;
    state.z = std::strtod(tokens[7].c_str(), nullptr) / 1000.0;
    states.push_back(std::move(state));
  });
  std::vector<uint8_t> oem;
  if (frame_code == 2) {
    oem = build_celestial_oem(object_name, object_id, norad,
                              CelestialFrame::EME2000, timingStandard::UTC,
                              states);
  } else if (frame_code == 0) {
    oem = build_custom_oem(object_name, object_id, norad, CustomFrame::ECEF,
                           timingStandard::UTC, states);
  }
  if (oem.empty()) return {};
  return {{std::move(oem)}};
}

bool kvn_value(const std::string& line, const char* key, std::string* value) {
  const std::string normalized = trim(line);
  const size_t key_length = std::strlen(key);
  if (normalized.compare(0, key_length, key) != 0) return false;
  size_t cursor = key_length;
  while (cursor < normalized.size() &&
         std::isspace(static_cast<unsigned char>(normalized[cursor]))) {
    ++cursor;
  }
  if (cursor >= normalized.size() || normalized[cursor] != '=') return false;
  *value = trim(normalized.substr(cursor + 1));
  return true;
}

std::vector<od::BatchObject> parse_iss_oem(const std::string& content) {
  std::string object_name = "ISS";
  std::string object_id = "1998-067A";
  std::vector<NativeState> states;
  for_each_line(content, [&](const std::string& line) {
    std::string value;
    if (kvn_value(line, "OBJECT_NAME", &value)) {
      object_name = value;
      return;
    }
    if (kvn_value(line, "OBJECT_ID", &value)) {
      object_id = value;
      return;
    }
    const std::vector<std::string> tokens = split_ws(line);
    if (tokens.size() < 7 || tokens[0].size() < 11 ||
        tokens[0].find('T') == std::string::npos ||
        tokens[0].find('=') != std::string::npos) {
      return;
    }
    NativeState state;
    state.epoch = normalize_iss_epoch(tokens[0]);
    state.x = std::strtod(tokens[1].c_str(), nullptr);
    state.y = std::strtod(tokens[2].c_str(), nullptr);
    state.z = std::strtod(tokens[3].c_str(), nullptr);
    state.vx = std::strtod(tokens[4].c_str(), nullptr);
    state.vy = std::strtod(tokens[5].c_str(), nullptr);
    state.vz = std::strtod(tokens[6].c_str(), nullptr);
    states.push_back(std::move(state));
  });
  std::vector<uint8_t> oem = build_celestial_oem(
      object_name, object_id, 25544, CelestialFrame::EME2000,
      timingStandard::UTC, states);
  if (oem.empty()) return {};
  return {{std::move(oem)}};
}

std::vector<od::BatchObject> parse_native_response(
    Provider provider, const Assembly& assembly) {
  const std::string content(assembly.bytes.begin(), assembly.bytes.end());
  switch (provider) {
    case Provider::Starlink:
      return parse_starlink_meme(content, assembly.schema_name);
    case Provider::Glonass:
      return parse_glonass_sp3(content);
    case Provider::Intelsat:
      return parse_intelsat_ecf(content);
    case Provider::Cpf:
      return parse_cpf(content);
    case Provider::Iss:
      return parse_iss_oem(content);
  }
  return {};
}

bool decode_chunk(const plugin_input_frame_t* frame, Chunk* chunk,
                  std::string* error) {
  if (!frame || !chunk || !frame->payload || frame->payload_length == 0 ||
      !frame->file_identifier ||
      std::strcmp(frame->file_identifier, kFsbFileIdentifier) != 0) {
    *error = "OD requires a typed $FSB input frame";
    return false;
  }
  chunk->wire_format = frame->wire_format;
  if (frame->wire_format == PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER) {
    flatbuffers::Verifier verifier(frame->payload, frame->payload_length);
    if (!VerifyFSBBuffer(verifier)) {
      *error = "invalid canonical FSB chunk";
      return false;
    }
    const FSB* stream = GetFSB(frame->payload);
    chunk->request_id = stream->REQUEST_ID();
    chunk->sequence = stream->CHUNK_SEQUENCE();
    chunk->final = stream->FINAL();
    chunk->total_bytes = stream->TOTAL_BYTES();
    chunk->record_count = stream->RECORD_COUNT();
    if (stream->SCHEMA_NAME()) chunk->schema_name = stream->SCHEMA_NAME()->str();
    if (stream->FILE_IDENTIFIER()) {
      chunk->file_identifier = stream->FILE_IDENTIFIER()->str();
    }
    if (stream->DATA()) {
      chunk->data.assign(stream->DATA()->begin(), stream->DATA()->end());
    }
    if (stream->SHA256()) {
      chunk->sha256.assign(stream->SHA256()->begin(), stream->SHA256()->end());
    }
    return true;
  }
  if (frame->wire_format == PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY) {
    if (frame->payload_length != kFsbAlignedSize ||
        reinterpret_cast<uintptr_t>(frame->payload) % kFsbAlignment != 0) {
      *error = "invalid aligned FSB bounds or alignment";
      return false;
    }
    const auto* stream = reinterpret_cast<const Aligned::FSB*>(frame->payload);
    chunk->request_id = stream->REQUEST_ID;
    chunk->sequence = stream->CHUNK_SEQUENCE;
    chunk->final = stream->FINAL;
    chunk->total_bytes = stream->TOTAL_BYTES;
    chunk->record_count = stream->RECORD_COUNT;
    if (stream->has_SCHEMA_NAME()) chunk->schema_name = stream->SCHEMA_NAME.str();
    if (stream->has_FILE_IDENTIFIER()) {
      chunk->file_identifier = stream->FILE_IDENTIFIER.str();
    }
    if (stream->has_DATA()) {
      chunk->data.assign(stream->DATA.values,
                         stream->DATA.values + stream->DATA.size());
    }
    if (stream->has_SHA256()) {
      chunk->sha256.assign(stream->SHA256.values,
                           stream->SHA256.values + stream->SHA256.size());
    }
    return true;
  }
  *error = "unsupported FSB wire format";
  return false;
}

bool verify_checksum(const Assembly& assembly) {
  if (assembly.sha256.empty()) return true;
  if (assembly.sha256.size() != 32) return false;
  uint8_t digest[32];
  sdn_cid::sha256_raw(assembly.bytes.data(), assembly.bytes.size(), digest);
  return std::memcmp(digest, assembly.sha256.data(), sizeof(digest)) == 0;
}

bool append_chunk(Provider provider, const Chunk& chunk, Assembly* completed,
                  std::string* error) {
  if (chunk.total_bytes == 0 || chunk.total_bytes > kMaxNativeResponseBytes) {
    *error = "native response TOTAL_BYTES is outside the OD bound";
    return false;
  }
  const AssemblyKey key{provider, chunk.request_id};
  auto found = g_assemblies.find(key);
  if (chunk.sequence == 0) {
    if (found != g_assemblies.end()) g_assemblies.erase(found);
    Assembly fresh;
    fresh.total_bytes = chunk.total_bytes;
    fresh.record_count = chunk.record_count;
    fresh.wire_format = chunk.wire_format;
    fresh.schema_name = chunk.schema_name;
    fresh.file_identifier = chunk.file_identifier;
    fresh.sha256 = chunk.sha256;
    fresh.bytes.reserve(static_cast<size_t>(chunk.total_bytes));
    found = g_assemblies.emplace(key, std::move(fresh)).first;
  }
  if (found == g_assemblies.end()) {
    *error = "native response chunk arrived without sequence zero";
    return false;
  }
  Assembly& assembly = found->second;
  if (chunk.sequence != assembly.next_sequence ||
      chunk.total_bytes != assembly.total_bytes ||
      chunk.wire_format != assembly.wire_format ||
      chunk.schema_name != assembly.schema_name ||
      chunk.file_identifier != assembly.file_identifier ||
      (!assembly.sha256.empty() && chunk.sha256 != assembly.sha256)) {
    g_assemblies.erase(found);
    *error = "native response chunk metadata or ordering mismatch";
    return false;
  }
  if (assembly.bytes.size() + chunk.data.size() > assembly.total_bytes) {
    g_assemblies.erase(found);
    *error = "native response chunks exceed TOTAL_BYTES";
    return false;
  }
  assembly.bytes.insert(assembly.bytes.end(), chunk.data.begin(), chunk.data.end());
  ++assembly.next_sequence;
  if (!chunk.final) return true;
  if (assembly.bytes.size() != assembly.total_bytes || !verify_checksum(assembly)) {
    g_assemblies.erase(found);
    *error = "final native response length or SHA256 mismatch";
    return false;
  }
  *completed = std::move(assembly);
  g_assemblies.erase(found);
  return true;
}

int32_t push_canonical_stream_chunk(
    const RecordStreamAccumulator& records, uint64_t request_id,
    uint32_t sequence, bool final, const uint8_t digest[32],
    const uint8_t* chunk_data, size_t chunk_size) {
  flatbuffers::FlatBufferBuilder builder(chunk_size + 256);
  const auto schema = builder.CreateString(records.schema_name);
  const auto identifier = builder.CreateString(records.file_identifier);
  const auto data = builder.CreateVector(chunk_data, chunk_size);
  const auto checksum = builder.CreateVector(digest, 32);
  FSBBuilder stream_builder(builder);
  stream_builder.add_REQUEST_ID(request_id);
  stream_builder.add_KIND(flatSqlByteStreamKind_RECORD_STREAM);
  stream_builder.add_CHUNK_SEQUENCE(sequence);
  stream_builder.add_FINAL(final);
  stream_builder.add_TOTAL_BYTES(records.data.size());
  stream_builder.add_RECORD_COUNT(records.record_count);
  stream_builder.add_SCHEMA_NAME(schema);
  stream_builder.add_FILE_IDENTIFIER(identifier);
  stream_builder.add_DATA(data);
  stream_builder.add_SHA256(checksum);
  const auto root = stream_builder.Finish();
  FinishFSBBuffer(builder, root);
  return plugin_push_output_typed(
      records.port_id, kFsbSchemaName, kFsbFileIdentifier,
      PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, kFsbRootType, 0, 0, 0,
      builder.GetBufferPointer(), static_cast<uint32_t>(builder.GetSize()));
}

int32_t push_aligned_stream_chunk(
    const RecordStreamAccumulator& stream, uint64_t request_id,
    uint32_t sequence, bool final, const uint8_t digest[32],
    const uint8_t* chunk_data, size_t chunk_size) {
  if (chunk_size > kFsbDataCapacity) return -1;
  std::memset(&g_aligned_output, 0, sizeof(g_aligned_output));
  g_aligned_output.REQUEST_ID = request_id;
  g_aligned_output.KIND = flatSqlByteStreamKind_RECORD_STREAM;
  g_aligned_output.CHUNK_SEQUENCE = sequence;
  g_aligned_output.FINAL = final;
  g_aligned_output.TOTAL_BYTES = stream.data.size();
  g_aligned_output.RECORD_COUNT = stream.record_count;
  g_aligned_output.SCHEMA_NAME.set(stream.schema_name);
  g_aligned_output.set_has_SCHEMA_NAME(true);
  g_aligned_output.FILE_IDENTIFIER.set(stream.file_identifier);
  g_aligned_output.set_has_FILE_IDENTIFIER(true);
  g_aligned_output.DATA.set_length(static_cast<uint32_t>(chunk_size));
  std::memcpy(g_aligned_output.DATA.values, chunk_data, chunk_size);
  g_aligned_output.set_has_DATA(true);
  g_aligned_output.SHA256.set_length(32);
  std::memcpy(g_aligned_output.SHA256.values, digest, 32);
  g_aligned_output.set_has_SHA256(true);
  return plugin_push_output_typed(
      stream.port_id, kFsbSchemaName, kFsbFileIdentifier,
      PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY, kFsbRootType, 0,
      kFsbAlignedSize, kFsbAlignment,
      reinterpret_cast<const uint8_t*>(&g_aligned_output), kFsbAlignedSize);
}

int32_t push_record_stream(const RecordStreamAccumulator& stream) {
  if (stream.data.empty() || stream.record_count == 0) return 0;
  uint8_t digest[32];
  sdn_cid::sha256_raw(stream.data.data(), stream.data.size(), digest);
  const uint64_t request_id = g_output_request_id++;
  size_t offset = 0;
  uint32_t sequence = 0;
  while (offset < stream.data.size()) {
    const size_t chunk_size =
        std::min(kFsbDataCapacity, stream.data.size() - offset);
    const bool final = offset + chunk_size == stream.data.size();
    const int32_t status =
        stream.wire_format == PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY
            ? push_aligned_stream_chunk(stream, request_id, sequence, final,
                                        digest, stream.data.data() + offset,
                                        chunk_size)
            : push_canonical_stream_chunk(stream, request_id, sequence, final,
                                          digest, stream.data.data() + offset,
                                          chunk_size);
    if (status < 0) return status;
    offset += chunk_size;
    ++sequence;
  }
  return 0;
}

bool append_record(std::vector<RecordStreamAccumulator>* streams,
                   const char* port_id, const char* schema_name,
                   const char* file_identifier,
                   const std::vector<uint8_t>& record,
                   uint32_t wire_format) {
  if (!streams) return false;
  if (record.empty()) return true;
  auto found = std::find_if(
      streams->begin(), streams->end(),
      [port_id, wire_format](const RecordStreamAccumulator& stream) {
        return stream.wire_format == wire_format &&
               std::strcmp(stream.port_id, port_id) == 0;
      });
  if (found == streams->end()) {
    streams->push_back({port_id, schema_name, file_identifier, wire_format});
    found = std::prev(streams->end());
  }
  if (record.size() > kMaxOutputStreamBytes - found->data.size()) return false;
  found->data.insert(found->data.end(), record.begin(), record.end());
  ++found->record_count;
  return true;
}

int32_t push_canonical_configuration(uint64_t request_id) {
  flatbuffers::FlatBufferBuilder builder(std::strlen(kResultSchemaIdl) + 1024);
  const auto database_name = builder.CreateString("supplemental-omm");
  const auto schema_idl = builder.CreateVector(
      reinterpret_cast<const uint8_t*>(kResultSchemaIdl),
      std::strlen(kResultSchemaIdl));
  std::vector<flatbuffers::Offset<FTB>> bindings;
  bindings.push_back(CreateFTBDirect(builder, "$OMM", "OMM"));
  bindings.push_back(CreateFTBDirect(builder, "$OCM", "OCM"));
  bindings.push_back(CreateFTBDirect(builder, "$OBD", "OBD"));
  const auto table_bindings = builder.CreateVector(bindings);
  FSOBuilder control(builder);
  control.add_OPERATION(flatSqlNodeOperation_CONFIGURE_INDEX);
  control.add_REQUEST_ID(request_id);
  control.add_DATABASE_NAME(database_name);
  control.add_SCHEMA_IDL(schema_idl);
  control.add_TABLE_BINDINGS(table_bindings);
  const auto root = control.Finish();
  FinishFSOBuffer(builder, root);
  return plugin_push_output_typed(
      "control", kFsoSchemaName, kFsoFileIdentifier,
      PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, kFsoRootType, 0, 0, 0,
      builder.GetBufferPointer(), static_cast<uint32_t>(builder.GetSize()));
}

void write_aligned_u32(uint32_t offset, uint32_t value) {
  std::memcpy(g_aligned_control + offset, &value, sizeof(value));
}

void write_aligned_u64(uint32_t offset, uint64_t value) {
  std::memcpy(g_aligned_control + offset, &value, sizeof(value));
}

bool write_aligned_string(uint32_t offset, size_t capacity,
                          const char* value) {
  const size_t length = std::strlen(value);
  if (length > capacity || length > 255) return false;
  g_aligned_control[offset] = static_cast<uint8_t>(length);
  std::memcpy(g_aligned_control + offset + 1, value, length);
  return true;
}

bool write_aligned_binding(uint32_t index, const char* file_identifier,
                           const char* table_name) {
  const uint32_t base = kAlignedFsoBindingsOffset + 4 +
                        index * kAlignedFsoBindingStride;
  g_aligned_control[base] = 3;
  return write_aligned_string(base + 1, 4, file_identifier) &&
         write_aligned_string(base + 6, 128, table_name);
}

int32_t push_aligned_configuration(uint64_t request_id) {
  const size_t schema_length = std::strlen(kResultSchemaIdl);
  if (schema_length > 262'144) return -1;
  std::memset(g_aligned_control, 0, sizeof(g_aligned_control));
  g_aligned_control[0] = 7;  // DATABASE_NAME, SCHEMA_IDL, TABLE_BINDINGS.
  g_aligned_control[2] =
      static_cast<uint8_t>(flatSqlNodeOperation_CONFIGURE_INDEX);
  write_aligned_u64(8, request_id);
  if (!write_aligned_string(kAlignedFsoDatabaseOffset, 128,
                            "supplemental-omm")) {
    return -1;
  }
  write_aligned_u32(kAlignedFsoSchemaOffset,
                    static_cast<uint32_t>(schema_length));
  std::memcpy(g_aligned_control + kAlignedFsoSchemaOffset + 4,
              kResultSchemaIdl, schema_length);
  write_aligned_u32(kAlignedFsoBindingsOffset, 3);
  if (!write_aligned_binding(0, "$OMM", "OMM") ||
      !write_aligned_binding(1, "$OCM", "OCM") ||
      !write_aligned_binding(2, "$OBD", "OBD")) {
    return -1;
  }
  return plugin_push_output_typed(
      "control", kFsoSchemaName, kFsoFileIdentifier,
      PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY, kFsoRootType, 0,
      kFsoAlignedSize, kFsoAlignment, g_aligned_control, kFsoAlignedSize);
}

int32_t push_configuration(uint32_t wire_format) {
  const uint64_t request_id = g_output_request_id++;
  if (wire_format == PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY) {
    return push_aligned_configuration(request_id);
  }
  return push_canonical_configuration(request_id);
}

bool append_result(std::vector<RecordStreamAccumulator>* streams,
                   const od::BatchResult& result, uint32_t wire_format) {
  bool accepted =
      append_record(streams, "omm", "OMM", "$OMM", result.omm,
                    wire_format) &&
      append_record(streams, "ocm", "OCM", "$OCM", result.ocm,
                    wire_format) &&
      append_record(streams, "obd", "OBD", "$OBD", result.obd,
                    wire_format);
  for (const od::BatchEpochResult& additional : result.additional_epochs) {
    accepted =
        accepted &&
        append_record(streams, "omm", "OMM", "$OMM", additional.omm,
                      wire_format) &&
        append_record(streams, "ocm", "OCM", "$OCM", additional.ocm,
                      wire_format) &&
        append_record(streams, "obd", "OBD", "$OBD", additional.obd,
                      wire_format);
  }
  return accepted;
}

bool provider_for_port(const char* port_id, Provider* provider) {
  if (!port_id || !provider) return false;
  for (const ProviderPort& candidate : kProviderPorts) {
    if (std::strcmp(port_id, candidate.port_id) == 0) {
      *provider = candidate.provider;
      return true;
    }
  }
  return false;
}

}  // namespace

extern "C" int fit(void) {
  plugin_reset_output_state();
  std::vector<od::BatchObject> objects;
  std::vector<uint32_t> output_wire_formats;
  std::string error;

  for (uint32_t index = 0; index < plugin_get_input_count(); ++index) {
    const plugin_input_frame_t* frame = plugin_get_input_frame(index);
    Provider provider;
    if (!frame || !provider_for_port(frame->port_id, &provider)) continue;
    Chunk chunk;
    if (!decode_chunk(frame, &chunk, &error)) {
      plugin_set_error("od-chunk-invalid", error.c_str());
      return 400;
    }
    Assembly completed;
    if (!append_chunk(provider, chunk, &completed, &error)) {
      plugin_set_error("od-chunk-invalid", error.c_str());
      return 400;
    }
    if (!chunk.final) continue;
    std::vector<od::BatchObject> parsed =
        parse_native_response(provider, completed);
    if (parsed.empty()) {
      plugin_set_error("od-native-parse", "complete provider response had fewer than three usable states");
      return 422;
    }
    for (od::BatchObject& object : parsed) {
      objects.push_back(std::move(object));
      output_wire_formats.push_back(completed.wire_format);
    }
  }

  if (objects.empty()) return 0;

  od::BatchRunStats stats{};
  const std::vector<od::BatchResult> results =
      od::run_batch_fit(objects, 0, &stats);
  size_t emitted = 0;
  uint32_t configuration_wire_format = PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER;
  std::vector<RecordStreamAccumulator> streams;
  std::string first_fit_error;
  for (size_t index = 0; index < results.size(); ++index) {
    const od::BatchResult& result = results[index];
    if (!result.ok || result.omm.empty()) {
      if (first_fit_error.empty()) first_fit_error = result.error_message;
      continue;
    }
    const uint32_t output_wire_format =
        index < output_wire_formats.size()
            ? output_wire_formats[index]
            : PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER;
    if (emitted == 0) configuration_wire_format = output_wire_format;
    if (!append_result(&streams, result, output_wire_format)) {
      plugin_set_error("od-output-too-large",
                       "one fitted schema stream exceeds 128 MiB");
      return 413;
    }
    ++emitted;
  }
  if (emitted == 0) {
    plugin_set_error(
        "od-fit",
        first_fit_error.empty() ? "OD produced no converged record set"
                                : first_fit_error.c_str());
    return 422;
  }
  if (push_configuration(configuration_wire_format) < 0) {
    plugin_set_error("od-output", "unable to emit FlatSQL CONFIGURE_INDEX control");
    return 500;
  }
  for (const RecordStreamAccumulator& stream : streams) {
    if (push_record_stream(stream) < 0) {
      plugin_set_error("od-output", "unable to emit fitted FSB record stream");
      return 500;
    }
  }
  return 0;
}
