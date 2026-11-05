// Text handling for the source documents: HTML to plain text, whitespace normalization, number and unit reading,
// CSV rows. Pure functions on bytes; no allocation limits beyond the caller's bounds.
#pragma once
#include <cctype>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

namespace sensortext {

inline void append_utf8(std::string& out, uint32_t cp) {
  if (cp < 0x80) out += static_cast<char>(cp);
  else if (cp < 0x800) { out += static_cast<char>(0xC0 | (cp >> 6)); out += static_cast<char>(0x80 | (cp & 0x3F)); }
  else if (cp < 0x10000) { out += static_cast<char>(0xE0 | (cp >> 12)); out += static_cast<char>(0x80 | ((cp >> 6) & 0x3F)); out += static_cast<char>(0x80 | (cp & 0x3F)); }
  else { out += static_cast<char>(0xF0 | (cp >> 18)); out += static_cast<char>(0x80 | ((cp >> 12) & 0x3F)); out += static_cast<char>(0x80 | ((cp >> 6) & 0x3F)); out += static_cast<char>(0x80 | (cp & 0x3F)); }
}

// The named entities OSCAR's pages use; any other named entity is kept as written.
inline bool named_entity(const std::string& name, uint32_t* cp) {
  static const struct { const char* name; uint32_t cp; } table[] = {
      {"amp", '&'}, {"lt", '<'}, {"gt", '>'}, {"quot", '"'}, {"apos", '\''}, {"nbsp", 0xA0}, {"micro", 0xB5}, {"deg", 0xB0}, {"ge", 0x2265},
      {"le", 0x2264}, {"ndash", 0x2013}, {"mdash", 0x2014}, {"plusmn", 0xB1}, {"times", 0xD7}, {"Delta", 0x394}, {"mu", 0x3BC}, {"rsquo", 0x2019},
      {"lsquo", 0x2018}, {"ldquo", 0x201C}, {"rdquo", 0x201D}, {"hellip", 0x2026}, {"minus", 0x2212}};
  for (const auto& e : table) if (name == e.name) { *cp = e.cp; return true; }
  return false;
}

inline std::string decode_entities(const std::string& in) {
  std::string out;
  out.reserve(in.size());
  for (size_t i = 0; i < in.size(); ++i) {
    if (in[i] != '&') { out += in[i]; continue; }
    const size_t semi = in.find(';', i + 1);
    if (semi == std::string::npos || semi - i > 10) { out += in[i]; continue; }
    const std::string name = in.substr(i + 1, semi - i - 1);
    uint32_t cp = 0;
    if (!name.empty() && name[0] == '#') {
      const bool hex = name.size() > 1 && (name[1] == 'x' || name[1] == 'X');
      char* end = nullptr;
      const unsigned long v = std::strtoul(name.c_str() + (hex ? 2 : 1), &end, hex ? 16 : 10);
      if (end && *end == '\0' && v > 0 && v < 0x110000) { append_utf8(out, static_cast<uint32_t>(v)); i = semi; continue; }
    } else if (named_entity(name, &cp)) { append_utf8(out, cp); i = semi; continue; }
    out += in[i];
  }
  return out;
}

// Whitespace runs (ASCII, NBSP U+00A0, thin and figure spaces U+2000..U+200A, U+202F, U+3000) become one space; the ends are trimmed.
inline std::string collapse(const std::string& in) {
  std::string out;
  out.reserve(in.size());
  bool space = true;
  for (size_t i = 0; i < in.size(); ++i) {
    const unsigned char c = static_cast<unsigned char>(in[i]);
    size_t skip = 0;
    bool is_space = c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\f' || c == '\v';
    if (!is_space && c == 0xC2 && i + 1 < in.size() && static_cast<unsigned char>(in[i + 1]) == 0xA0) is_space = true, skip = 1;
    if (!is_space && c == 0xE2 && i + 2 < in.size()) {
      const unsigned char b1 = static_cast<unsigned char>(in[i + 1]), b2 = static_cast<unsigned char>(in[i + 2]);
      if ((b1 == 0x80 && ((b2 >= 0x80 && b2 <= 0x8A) || b2 == 0xAF))) is_space = true, skip = 2;
    }
    if (is_space) { if (!space) out += ' '; space = true; i += skip; continue; }
    out += in[i];
    space = false;
  }
  while (!out.empty() && out.back() == ' ') out.pop_back();
  return out;
}

// HTML to plain text: script and style blocks removed, every tag one space, entities decoded, whitespace collapsed.
inline std::string html_text(const std::string& html) {
  std::string out;
  out.reserve(html.size() / 2);
  for (size_t i = 0; i < html.size();) {
    if (html[i] == '<') {
      auto starts = [&](const char* word) {
        const size_t n = std::strlen(word);
        if (html.size() - i < n + 1) return false;
        for (size_t k = 0; k < n; ++k) if (std::tolower(static_cast<unsigned char>(html[i + 1 + k])) != word[k]) return false;
        return true;
      };
      const char* block = starts("script") ? "</script" : starts("style") ? "</style" : nullptr;
      if (block) {
        size_t close = std::string::npos;
        for (size_t j = i; j + std::strlen(block) < html.size(); ++j) {
          size_t k = 0;
          while (block[k] && std::tolower(static_cast<unsigned char>(html[j + k])) == block[k]) ++k;
          if (!block[k]) { close = j; break; }
        }
        const size_t gt = close == std::string::npos ? std::string::npos : html.find('>', close);
        i = gt == std::string::npos ? html.size() : gt + 1;
        out += ' ';
        continue;
      }
      const size_t gt = html.find('>', i);
      if (gt == std::string::npos) break;
      i = gt + 1;
      out += ' ';
      continue;
    }
    out += html[i++];
  }
  return collapse(decode_entities(out));
}

// The text between two markers of a collapsed text (first `from`, then the first `to` after it); empty when either is missing.
inline std::string between(const std::string& text, const std::string& from, const std::string& to) {
  const size_t a = text.find(from);
  if (a == std::string::npos) return std::string();
  const size_t start = a + from.size();
  const size_t b = text.find(to, start);
  if (b == std::string::npos) return std::string();
  return collapse(text.substr(start, b - start));
}

// A number at the start of s (after spaces), commas as thousands separators removed; *rest is what follows.
inline bool read_number(const std::string& s, double* value, std::string* rest) {
  size_t i = 0;
  while (i < s.size() && s[i] == ' ') ++i;
  std::string digits;
  const size_t begin = i;
  if (i < s.size() && (s[i] == '+' || s[i] == '-')) digits += s[i++];
  bool any = false, dot = false;
  for (; i < s.size(); ++i) {
    if (s[i] >= '0' && s[i] <= '9') { digits += s[i]; any = true; }
    else if (s[i] == '.' && !dot) { digits += s[i]; dot = true; }
    else if (s[i] == ',' && any && i + 1 < s.size() && s[i + 1] >= '0' && s[i + 1] <= '9') continue;
    else break;
  }
  (void)begin;
  if (!any) return false;
  char* end = nullptr;
  *value = std::strtod(digits.c_str(), &end);
  if (!end || *end != '\0' || !std::isfinite(*value)) return false;
  if (rest) *rest = s.substr(i);
  return true;
}

// The scale to metres of a wavelength unit ("nm", "um" in its three spellings), 0 when the text is not one.
inline double wavelength_scale(const std::string& unit) {
  if (unit == "nm") return 1e-9;
  if (unit == "\xC2\xB5m" || unit == "\xCE\xBCm" || unit == "um") return 1e-6;  // U+00B5, U+03BC, ASCII
  if (unit == "mm") return 1e-3;
  return 0;
}
inline double frequency_scale(const std::string& unit) {
  if (unit == "GHz") return 1e9;
  if (unit == "MHz") return 1e6;
  if (unit == "kHz") return 1e3;
  if (unit == "Hz") return 1;
  return 0;
}

inline std::string strip_spaces(const std::string& s) { return collapse(s); }

// One CSV record from `pos` (RFC 4180: quotes double to escape); advances pos past the record's line end. False at the end.
inline bool csv_row(const std::string& text, size_t* pos, std::vector<std::string>* row) {
  row->clear();
  if (*pos >= text.size()) return false;
  std::string field;
  bool quoted = false;
  size_t i = *pos;
  for (; i < text.size(); ++i) {
    const char c = text[i];
    if (quoted) {
      if (c == '"') { if (i + 1 < text.size() && text[i + 1] == '"') { field += '"'; ++i; } else quoted = false; }
      else field += c;
    } else if (c == '"') quoted = true;
    else if (c == ',') { row->push_back(field); field.clear(); }
    else if (c == '\n') { ++i; break; }
    else if (c != '\r') field += c;
  }
  row->push_back(field);
  *pos = i;
  return true;
}

}  // namespace sensortext
