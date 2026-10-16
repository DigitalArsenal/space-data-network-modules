#pragma once
#include <array>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <limits>
#include <string>
#include <vector>

// State-only encoding: one six-component row is 48 little-endian bytes and
// therefore exactly 64 base64 characters, with no padding or row separators.
namespace packed_rows {
static_assert(sizeof(double) == 8 && std::numeric_limits<double>::is_iec559,
              "Packed trajectory rows require IEEE-754 float64");
constexpr size_t kCharsPerRow = 64;

inline void append(std::string& text, const std::array<double, 6>& row) {
  constexpr char alphabet[] =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::array<uint8_t, 48> bytes{};
  for (size_t i = 0; i < row.size(); ++i) {
    uint64_t bits;
    std::memcpy(&bits, &row[i], sizeof(bits));
    for (size_t j = 0; j < 8; ++j) bytes[i * 8 + j] = uint8_t(bits >> (j * 8));
  }
  for (size_t i = 0; i < bytes.size(); i += 3) {
    const uint32_t bits = uint32_t(bytes[i]) << 16 |
        uint32_t(bytes[i + 1]) << 8 | uint32_t(bytes[i + 2]);
    text.push_back(alphabet[(bits >> 18) & 63]);
    text.push_back(alphabet[(bits >> 12) & 63]);
    text.push_back(alphabet[(bits >> 6) & 63]);
    text.push_back(alphabet[bits & 63]);
  }
}

namespace detail {
inline int sextet(unsigned char c) {
  if (c >= 'A' && c <= 'Z') return c - 'A';
  if (c >= 'a' && c <= 'z') return c - 'a' + 26;
  if (c >= '0' && c <= '9') return c - '0' + 52;
  if (c == '+') return 62;
  if (c == '/') return 63;
  return -1;
}

// Scan without allocating when validating; decode with the same strict rules.
inline bool scan(const std::string& text, std::vector<double>* values) {
  if (text.size() % kCharsPerRow != 0) return false;
  uint64_t bits = 0;
  unsigned byte = 0;
  for (size_t i = 0; i < text.size(); i += 4) {
    uint32_t triplet = 0;
    for (size_t j = 0; j < 4; ++j) {
      const int value = sextet(static_cast<unsigned char>(text[i + j]));
      if (value < 0) return false;
      triplet = (triplet << 6) | uint32_t(value);
    }
    for (int shift = 16; shift >= 0; shift -= 8) {
      bits |= uint64_t((triplet >> shift) & 255) << (byte * 8);
      if (++byte == 8) {
        double value;
        std::memcpy(&value, &bits, sizeof(value));
        if (!std::isfinite(value)) return false;
        if (values) values->push_back(value);
        bits = 0;
        byte = 0;
      }
    }
  }
  return true;
}
}  // namespace detail

inline bool validate(const std::string& text, size_t maxRows, size_t& rowCount) {
  rowCount = 0;
  if (text.size() % kCharsPerRow != 0 || text.size() / kCharsPerRow > maxRows ||
      !detail::scan(text, nullptr)) return false;
  rowCount = text.size() / kCharsPerRow;
  return true;
}

inline bool decode(const std::string& text, std::vector<double>& values) {
  values.clear();
  if (text.size() % kCharsPerRow != 0) return false;
  values.reserve(text.size() / kCharsPerRow * 6);
  if (detail::scan(text, &values)) return true;
  values.clear();
  return false;
}
}  // namespace packed_rows
