// The registry: format token -> parser (formats.hpp).
#include "formats.hpp"

#include "formats_support.hpp"

namespace odhpop::formats {
namespace {

struct Entry {
  const char* token;
  ParseResult (*parse)(const uint8_t*, std::size_t);
};

const Entry kEntries[] = {
    {"css-oem-zip", detail::parse_css_oem_zip},
    {"planet-states", detail::parse_planet_states},
    {"iess412-i11", detail::parse_iess412_i11},
    {"oneweb-ltef", detail::parse_oneweb_ltef},
    {"moditc", detail::parse_moditc},
    {"sp3", detail::parse_sp3},
    {"cpf", detail::parse_cpf},
};

}  // namespace

ParseResult parse(const std::string& format, const uint8_t* bytes, std::size_t size) {
  for (const Entry& e : kEntries)
    if (format == e.token) {
      if (bytes == nullptr || size == 0) return detail::failure("parse-failed", "empty " + format + " input");
      return e.parse(bytes, size);
    }
  return detail::failure("unsupported-format", "no parser for format \"" + format + "\"");
}

std::vector<std::string> formats() {
  std::vector<std::string> out;
  for (const Entry& e : kEntries) out.emplace_back(e.token);
  return out;
}

}  // namespace odhpop::formats
