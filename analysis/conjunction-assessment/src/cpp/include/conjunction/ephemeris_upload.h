#pragma once
#include "OEM_generated.h"
#include <string>

namespace conjunction {
namespace upload { bool timestamp(const std::string&, bool, std::string&, double&); }
// Text parsing/validation is independent of the SDK transport adapter.
struct UploadOptions {
  double reference_jd = 0;
  std::string format, object_id, object_name;
};
struct UploadResult {
  OEMT oem;
  std::string format, code, message;
  size_t states = 0;
};
bool parse_ephemeris_upload(const std::string&, const UploadOptions&, UploadResult&);
}
