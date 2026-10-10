// Helpers shared by the provider-format parsers (formats.hpp is the contract).
// Text scanning, numbers, calendar arithmetic and the in-memory container
// readers (deflate, gzip, zip). Nothing here touches a filesystem.
#pragma once

#include <cstddef>
#include <cstdint>
#include <string>
#include <string_view>
#include <vector>

#include "formats.hpp"

namespace odhpop::formats::detail {

ParseResult failure(const std::string& code, const std::string& message);

// Lines without their CR/LF; the last line is kept even without a newline.
std::vector<std::string_view> lines_of(const uint8_t* bytes, std::size_t size);
std::string_view trim(std::string_view s);
std::vector<std::string_view> tokens(std::string_view s);
// The whole token must be one finite number.
bool to_double(std::string_view s, double* out);
bool to_int(std::string_view s, long long* out);
bool starts_with(std::string_view s, std::string_view prefix);
std::string upper(std::string_view s);

// Proleptic Gregorian days since 1970-01-01 (and back).
long long days_from_civil(int y, int m, int d);
void civil_from_days(long long z, int* y, int* m, int* d);
// "YYYY-MM-DDTHH:MM:SS[.fff]"; `seconds` is the source's own digits ("5.25"
// -> "05.25"), so the epoch is exactly as precise as the file.
std::string iso_datetime(int y, int mo, int d, int h, int mi, std::string_view seconds);

// Raw deflate (RFC 1951). `limit` bounds the expansion. Empty string: success.
std::string inflate_raw(const uint8_t* in, std::size_t size, std::size_t limit,
                        std::vector<uint8_t>* out, std::size_t* consumed = nullptr);
// gzip member (RFC 1952), CRC and length checked. Empty string: success.
std::string gunzip(const uint8_t* in, std::size_t size, std::size_t limit, std::vector<uint8_t>* out);

struct ZipMember {
  std::string name;
  std::vector<uint8_t> data;
};
// Stored and deflated members through the central directory; CRC-32 checked;
// total expansion bounded by `limit`. Empty string: success.
std::string unzip(const uint8_t* bytes, std::size_t size, std::size_t limit,
                  std::vector<ZipMember>* members);

// One parser per provider format (one .cpp each).
ParseResult parse_css_oem_zip(const uint8_t* bytes, std::size_t size);
ParseResult parse_planet_states(const uint8_t* bytes, std::size_t size);
ParseResult parse_iess412_i11(const uint8_t* bytes, std::size_t size);
ParseResult parse_oneweb_ltef(const uint8_t* bytes, std::size_t size);
ParseResult parse_moditc(const uint8_t* bytes, std::size_t size);
ParseResult parse_sp3(const uint8_t* bytes, std::size_t size);
ParseResult parse_cpf(const uint8_t* bytes, std::size_t size);

}  // namespace odhpop::formats::detail
