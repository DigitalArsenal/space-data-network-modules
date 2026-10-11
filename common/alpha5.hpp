#pragma once
// common/alpha5.hpp: catalog numbers as the two-line element format and Space-Track write them.
//
// Five columns hold 0..99999 as digits. Alpha-5 extends them to 339999: the first column is a letter
// (A = 10 ... Z = 33, omitting I and O, which look like 1 and 0) and the other four are digits, so
// A0000 is 100000 and Z9999 is 339999. Space-Track assigns catalog numbers above 99999 in this form
// in its two-line sets; its JSON carries them as decimal text.
#include <cstdint>
#include <string>

namespace sdn_alpha5 {

inline bool is_digits(const std::string& text, size_t first, size_t count) {
  if (first + count > text.size()) return false;
  for (size_t i = first; i < first + count; ++i) {
    if (text[i] < '0' || text[i] > '9') return false;
  }
  return true;
}

// `text` is a catalog number with its padding already removed: decimal digits (1 to 9 of them, not
// zero) or a letter and four digits. False for anything else, and `*out` is then untouched.
inline bool decode(const std::string& text, uint32_t* out) {
  if (text.empty()) return false;
  if (text[0] >= '0' && text[0] <= '9') {
    if (text.size() > 9 || !is_digits(text, 0, text.size())) return false;
    uint32_t value = 0;
    for (char c : text) value = value * 10 + static_cast<uint32_t>(c - '0');
    if (value == 0) return false;
    *out = value;
    return true;
  }
  static const char kLetters[] = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  if (text.size() != 5 || !is_digits(text, 1, 4)) return false;
  uint32_t prefix = 0;
  for (const char* p = kLetters; *p; ++p, ++prefix) {
    if (*p == text[0]) {
      uint32_t tail = 0;
      for (size_t i = 1; i < 5; ++i) tail = tail * 10 + static_cast<uint32_t>(text[i] - '0');
      *out = (prefix + 10) * 10000 + tail;
      return true;
    }
  }
  return false;
}

}  // namespace sdn_alpha5
