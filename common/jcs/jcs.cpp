#include "jcs.h"

#include <algorithm>
#include <cmath>
#include <cstdio>

namespace sdn::jcs {
namespace {

// ---- UTF-8 / UTF-16 helpers (for RFC 8785 key ordering) --------------------

void AppendUtf8(uint32_t cp, std::string* out) {
  if (cp <= 0x7F) {
    out->push_back(static_cast<char>(cp));
  } else if (cp <= 0x7FF) {
    out->push_back(static_cast<char>(0xC0 | (cp >> 6)));
    out->push_back(static_cast<char>(0x80 | (cp & 0x3F)));
  } else if (cp <= 0xFFFF) {
    out->push_back(static_cast<char>(0xE0 | (cp >> 12)));
    out->push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
    out->push_back(static_cast<char>(0x80 | (cp & 0x3F)));
  } else {
    out->push_back(static_cast<char>(0xF0 | (cp >> 18)));
    out->push_back(static_cast<char>(0x80 | ((cp >> 12) & 0x3F)));
    out->push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
    out->push_back(static_cast<char>(0x80 | (cp & 0x3F)));
  }
}

// Decode the next UTF-8 code point starting at s[i]; advances i. Lenient: a bad
// byte is returned as-is so ordering stays total.
uint32_t NextCodePoint(const std::string& s, size_t* i) {
  const auto c = static_cast<unsigned char>(s[*i]);
  if (c < 0x80) { ++*i; return c; }
  size_t extra = 0;
  uint32_t cp = 0;
  if ((c & 0xE0) == 0xC0) { extra = 1; cp = c & 0x1F; }
  else if ((c & 0xF0) == 0xE0) { extra = 2; cp = c & 0x0F; }
  else if ((c & 0xF8) == 0xF0) { extra = 3; cp = c & 0x07; }
  else { ++*i; return c; }
  if (*i + extra >= s.size()) { ++*i; return c; }
  for (size_t k = 1; k <= extra; ++k) {
    const auto cc = static_cast<unsigned char>(s[*i + k]);
    if ((cc & 0xC0) != 0x80) { ++*i; return c; }
    cp = (cp << 6) | (cc & 0x3F);
  }
  *i += extra + 1;
  return cp;
}

std::vector<uint16_t> ToUtf16(const std::string& s) {
  std::vector<uint16_t> units;
  size_t i = 0;
  while (i < s.size()) {
    const uint32_t cp = NextCodePoint(s, &i);
    if (cp <= 0xFFFF) {
      units.push_back(static_cast<uint16_t>(cp));
    } else {
      const uint32_t v = cp - 0x10000;
      units.push_back(static_cast<uint16_t>(0xD800 + (v >> 10)));
      units.push_back(static_cast<uint16_t>(0xDC00 + (v & 0x3FF)));
    }
  }
  return units;
}

// RFC 8785 §3.2.3: object keys sorted by their UTF-16 code-unit sequences.
bool KeyLess(const std::string& a, const std::string& b) {
  return ToUtf16(a) < ToUtf16(b);
}

// ---- Serialization ---------------------------------------------------------

void SerializeString(const std::string& s, std::string* out) {
  out->push_back('"');
  for (size_t i = 0; i < s.size(); ++i) {
    const auto c = static_cast<unsigned char>(s[i]);
    switch (c) {
      case '"': out->append("\\\""); break;
      case '\\': out->append("\\\\"); break;
      case '\b': out->append("\\b"); break;
      case '\f': out->append("\\f"); break;
      case '\n': out->append("\\n"); break;
      case '\r': out->append("\\r"); break;
      case '\t': out->append("\\t"); break;
      default:
        if (c < 0x20) {
          char buf[7];
          std::snprintf(buf, sizeof(buf), "\\u%04x", c);
          out->append(buf);
        } else {
          // RFC 8785: no escaping of '/', '<', '>', '&', or any non-ASCII; raw UTF-8.
          out->push_back(static_cast<char>(c));
        }
    }
  }
  out->push_back('"');
}

void SerializeDouble(double d, std::string* out) {
  if (std::isfinite(d) && d == std::floor(d) && std::fabs(d) < 9.007199254740992e15) {
    out->append(std::to_string(static_cast<int64_t>(d)));
    return;
  }
  // EPM content uses no non-integer numbers; this branch is best-effort only.
  char buf[32];
  std::snprintf(buf, sizeof(buf), "%.17g", d);
  out->append(buf);
}

void Serialize(const JsonValue& v, std::string* out) {
  switch (v.type) {
    case JsonValue::Type::Null:
      out->append("null");
      break;
    case JsonValue::Type::Bool:
      out->append(v.boolean ? "true" : "false");
      break;
    case JsonValue::Type::Int:
      out->append(std::to_string(v.integer));
      break;
    case JsonValue::Type::Double:
      SerializeDouble(v.number, out);
      break;
    case JsonValue::Type::String:
      SerializeString(v.str, out);
      break;
    case JsonValue::Type::Array: {
      out->push_back('[');
      for (size_t i = 0; i < v.array.size(); ++i) {
        if (i) out->push_back(',');
        Serialize(v.array[i], out);
      }
      out->push_back(']');
      break;
    }
    case JsonValue::Type::Object: {
      std::vector<const std::pair<std::string, JsonValue>*> members;
      members.reserve(v.object.size());
      for (const auto& m : v.object) members.push_back(&m);
      std::stable_sort(members.begin(), members.end(),
                       [](const auto* a, const auto* b) { return KeyLess(a->first, b->first); });
      out->push_back('{');
      for (size_t i = 0; i < members.size(); ++i) {
        if (i) out->push_back(',');
        SerializeString(members[i]->first, out);
        out->push_back(':');
        Serialize(members[i]->second, out);
      }
      out->push_back('}');
      break;
    }
  }
}

// ---- Parsing ---------------------------------------------------------------

struct Parser {
  const std::string& s;
  size_t i = 0;
  bool ok = true;

  explicit Parser(const std::string& src) : s(src) {}

  void SkipWs() {
    while (i < s.size()) {
      const char c = s[i];
      if (c == ' ' || c == '\t' || c == '\n' || c == '\r') ++i;
      else break;
    }
  }

  bool Hex4(uint32_t* out) {
    if (i + 4 > s.size()) return false;
    uint32_t v = 0;
    for (int k = 0; k < 4; ++k) {
      const char c = s[i + k];
      v <<= 4;
      if (c >= '0' && c <= '9') v |= static_cast<uint32_t>(c - '0');
      else if (c >= 'a' && c <= 'f') v |= static_cast<uint32_t>(c - 'a' + 10);
      else if (c >= 'A' && c <= 'F') v |= static_cast<uint32_t>(c - 'A' + 10);
      else return false;
    }
    i += 4;
    *out = v;
    return true;
  }

  JsonValue ParseString() {
    JsonValue v = JsonValue::Str("");
    ++i;  // opening quote
    while (i < s.size()) {
      const char c = s[i];
      if (c == '"') { ++i; return v; }
      if (c == '\\') {
        ++i;
        if (i >= s.size()) break;
        const char e = s[i++];
        switch (e) {
          case '"': v.str.push_back('"'); break;
          case '\\': v.str.push_back('\\'); break;
          case '/': v.str.push_back('/'); break;
          case 'b': v.str.push_back('\b'); break;
          case 'f': v.str.push_back('\f'); break;
          case 'n': v.str.push_back('\n'); break;
          case 'r': v.str.push_back('\r'); break;
          case 't': v.str.push_back('\t'); break;
          case 'u': {
            uint32_t cp = 0;
            if (!Hex4(&cp)) { ok = false; return v; }
            if (cp >= 0xD800 && cp <= 0xDBFF) {  // high surrogate
              if (i + 1 < s.size() && s[i] == '\\' && s[i + 1] == 'u') {
                i += 2;
                uint32_t lo = 0;
                if (!Hex4(&lo)) { ok = false; return v; }
                cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
              }
            }
            AppendUtf8(cp, &v.str);
            break;
          }
          default: ok = false; return v;
        }
      } else {
        v.str.push_back(c);
        ++i;
      }
    }
    ok = false;
    return v;
  }

  JsonValue ParseNumber() {
    const size_t start = i;
    bool is_double = false;
    if (i < s.size() && s[i] == '-') ++i;
    while (i < s.size()) {
      const char c = s[i];
      if (c >= '0' && c <= '9') ++i;
      else if (c == '.' || c == 'e' || c == 'E' || c == '+' || c == '-') { is_double = true; ++i; }
      else break;
    }
    const std::string tok = s.substr(start, i - start);
    if (!is_double) {
      try {
        return JsonValue::Int(static_cast<int64_t>(std::stoll(tok)));
      } catch (...) {
        is_double = true;  // out of int64 range -> fall through to double
      }
    }
    JsonValue v;
    v.type = JsonValue::Type::Double;
    try {
      v.number = std::stod(tok);
    } catch (...) {
      ok = false;
    }
    return v;
  }

  bool Literal(const char* lit) {
    const size_t n = std::char_traits<char>::length(lit);
    if (s.compare(i, n, lit) == 0) { i += n; return true; }
    return false;
  }

  JsonValue ParseValue() {
    SkipWs();
    if (i >= s.size()) { ok = false; return JsonValue::Null(); }
    const char c = s[i];
    if (c == '"') return ParseString();
    if (c == '{') return ParseObject();
    if (c == '[') return ParseArray();
    if (c == '-' || (c >= '0' && c <= '9')) return ParseNumber();
    if (Literal("true")) return JsonValue::Bool(true);
    if (Literal("false")) return JsonValue::Bool(false);
    if (Literal("null")) return JsonValue::Null();
    ok = false;
    return JsonValue::Null();
  }

  JsonValue ParseArray() {
    JsonValue v = JsonValue::Arr();
    ++i;  // [
    SkipWs();
    if (i < s.size() && s[i] == ']') { ++i; return v; }
    while (ok) {
      v.array.push_back(ParseValue());
      SkipWs();
      if (i >= s.size()) { ok = false; break; }
      if (s[i] == ',') { ++i; continue; }
      if (s[i] == ']') { ++i; break; }
      ok = false;
    }
    return v;
  }

  JsonValue ParseObject() {
    JsonValue v = JsonValue::Obj();
    ++i;  // {
    SkipWs();
    if (i < s.size() && s[i] == '}') { ++i; return v; }
    while (ok) {
      SkipWs();
      if (i >= s.size() || s[i] != '"') { ok = false; break; }
      JsonValue key = ParseString();
      if (!ok) break;
      SkipWs();
      if (i >= s.size() || s[i] != ':') { ok = false; break; }
      ++i;
      JsonValue val = ParseValue();
      v.object.emplace_back(std::move(key.str), std::move(val));
      SkipWs();
      if (i >= s.size()) { ok = false; break; }
      if (s[i] == ',') { ++i; continue; }
      if (s[i] == '}') { ++i; break; }
      ok = false;
    }
    return v;
  }
};

}  // namespace

std::string Canonicalize(const JsonValue& value) {
  std::string out;
  Serialize(value, &out);
  return out;
}

bool Parse(const std::string& json, JsonValue* out) {
  Parser p(json);
  JsonValue v = p.ParseValue();
  if (!p.ok) return false;
  p.SkipWs();
  if (p.i != json.size()) return false;  // trailing garbage
  *out = std::move(v);
  return true;
}

bool CanonicalizeJson(const std::string& json, std::string* out) {
  JsonValue v;
  if (!Parse(json, &v)) return false;
  *out = Canonicalize(v);
  return true;
}

}  // namespace sdn::jcs
