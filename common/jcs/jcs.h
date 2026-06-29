#ifndef SDN_COMMON_JCS_H
#define SDN_COMMON_JCS_H

// RFC 8785 JSON Canonicalization Scheme (JCS).
//
// One isomorphic canonicalizer (no Go, no JS-only path): the same code produces
// the exact bytes that get signed/verified in the browser and on wasmedge. Used
// for EPM attestation signing content so the wallet signer and the in-module
// verifier agree byte-for-byte.
//
// Scope: full JCS for objects (keys sorted by UTF-16 code units, recursively),
// arrays, strings (minimal ECMAScript escaping — NO HTML escaping, non-ASCII
// emitted as raw UTF-8), booleans, null, and integer numbers. NOTE: full
// ECMAScript serialization of non-integer doubles (RFC 8785 number test file) is
// out of scope — EPM content carries only integer fields (e.g. SIGNATURE_TIMESTAMP).

#include <cstdint>
#include <string>
#include <utility>
#include <vector>

namespace sdn::jcs {

struct JsonValue {
  enum class Type { Null, Bool, Int, Double, String, Array, Object };

  Type type = Type::Null;
  bool boolean = false;
  int64_t integer = 0;
  double number = 0.0;
  std::string str;
  std::vector<JsonValue> array;
  std::vector<std::pair<std::string, JsonValue>> object;  // insertion order; sorted on output

  static JsonValue Null() { return JsonValue{}; }
  static JsonValue Bool(bool v) { JsonValue j; j.type = Type::Bool; j.boolean = v; return j; }
  static JsonValue Int(int64_t v) { JsonValue j; j.type = Type::Int; j.integer = v; return j; }
  static JsonValue Str(std::string v) { JsonValue j; j.type = Type::String; j.str = std::move(v); return j; }
  static JsonValue Arr() { JsonValue j; j.type = Type::Array; return j; }
  static JsonValue Obj() { JsonValue j; j.type = Type::Object; return j; }
};

// Serialize `value` to its RFC 8785 canonical form (UTF-8 bytes).
std::string Canonicalize(const JsonValue& value);

// Parse a JSON document into a JsonValue. Returns false on malformed input.
bool Parse(const std::string& json, JsonValue* out);

// Convenience: parse `json` then canonicalize. Returns false on parse error.
bool CanonicalizeJson(const std::string& json, std::string* out);

}  // namespace sdn::jcs

#endif  // SDN_COMMON_JCS_H
