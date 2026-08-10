#ifndef MANEUVER_JSON_LITE_H
#define MANEUVER_JSON_LITE_H

#include <cstddef>
#include <string>
#include <string_view>
#include <vector>

namespace maneuver {

/**
 * A SMALL, NO-THROW JSON READER AND WRITER.
 *
 * 0.1.0 used nlohmann/json. Under the sanctioned wasi toolchain the guest is
 * compiled `-fno-exceptions`, and nlohmann's entire error contract is
 * exceptions: `at()`, `get<T>()` and `parse()` all throw, and with
 * JSON_NOEXCEPTION they call `std::abort()` instead — which is the SAME trap,
 * reached by a different route. There is no configuration of that library that
 * turns a malformed request into a value a caller can read, so it is not the
 * right dependency for a boundary whose contract is "no input may trap".
 *
 * What replaces it is deliberately small: this module's wire format is one
 * JSON object in and one JSON object out, with numbers, booleans, strings,
 * arrays and nested objects. Everything below is written to that, and every
 * failure is a returned `false` or a latched fault.
 *
 * THE HAZARDS THIS IS WRITTEN AGAINST, all of which are reachable from a
 * hostile payload and all of which are trap classes rather than error classes:
 *
 *   - Unbounded recursion. `[[[[[...` a few hundred thousand deep exhausts the
 *     wasm stack, and stack exhaustion is a trap, not an error. Depth is
 *     capped (`kMaxDepth`) and the cap is checked BEFORE recursing.
 *   - `strtod` accepting more than JSON does. It happily reads "inf", "nan",
 *     "0x10" and locale oddities; JSON has none of those. The token is
 *     validated against the JSON number grammar before conversion.
 *   - Non-finite numbers on the way OUT. `NaN` and `Infinity` are not JSON,
 *     and a consumer that JSON.parse()s them gets a syntax error at the far
 *     end of a successful call. The writer refuses instead (see `finite()`).
 */
namespace json_lite {

/// Nesting cap. A request that needs more than this is not a maneuver request.
inline constexpr int kMaxDepth = 64;

enum class Kind { Null, Bool, Number, String, Array, Object };

/// A parsed JSON value. Owns its children; copying is not needed and not done.
class Value {
  public:
    Kind kind = Kind::Null;
    bool boolean = false;
    double number = 0.0;
    std::string text;
    std::vector<Value> items;                      // Array
    std::vector<std::pair<std::string, Value>> members;  // Object

    bool isNull() const { return kind == Kind::Null; }
    bool isNumber() const { return kind == Kind::Number; }
    bool isBool() const { return kind == Kind::Bool; }
    bool isString() const { return kind == Kind::String; }
    bool isArray() const { return kind == Kind::Array; }
    bool isObject() const { return kind == Kind::Object; }

    /// Member lookup; nullptr when absent or when this is not an object.
    const Value* find(std::string_view key) const;
    bool has(std::string_view key) const { return find(key) != nullptr; }
};

/// Parse a complete JSON document. Returns false and fills `error` on any
/// malformed input; never throws, never aborts, never recurses past kMaxDepth.
bool parse(std::string_view text, Value* out, std::string* error);

// ---------------------------------------------------------------------------
// Guarded readers. Each raises a fault (maneuver/fault.h) with a message
// naming the operation and the field, and returns false, so a caller reads:
//
//     double r1 = 0.0;
//     if (!requireNumber(params, "r1", op, &r1)) return {};
// ---------------------------------------------------------------------------

/// Required finite number.
bool requireNumber(const Value& object, const char* key, const char* operation,
                   double* out);
/// Required finite number constrained to (0, inf).
bool requirePositive(const Value& object, const char* key,
                     const char* operation, double* out);
/// Optional finite number; leaves `*out` at its default when absent.
bool optionalNumber(const Value& object, const char* key,
                    const char* operation, double* out);
/// Optional finite number constrained to (0, inf).
bool optionalPositive(const Value& object, const char* key,
                      const char* operation, double* out);
/// Required integer (a JSON number with no fractional part, in int range).
bool requireInt(const Value& object, const char* key, const char* operation,
                int* out);
/// Optional integer.
bool optionalInt(const Value& object, const char* key, const char* operation,
                 int* out);
/// Optional boolean.
bool optionalBool(const Value& object, const char* key, const char* operation,
                  bool* out);
/// Optional string.
bool optionalString(const Value& object, const char* key,
                    const char* operation, std::string* out);
/// Required array of exactly three finite numbers.
bool requireVec3(const Value& object, const char* key, const char* operation,
                 double out[3]);
/// Optional array of exactly three finite numbers.
bool optionalVec3(const Value& object, const char* key, const char* operation,
                  double out[3], bool* present);
/// Required object member.
bool requireObject(const Value& object, const char* key, const char* operation,
                   const Value** out);
/// Required array member.
bool requireArray(const Value& object, const char* key, const char* operation,
                  const Value** out);

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

/// Builds a JSON object incrementally. Refuses non-finite numbers: `ok()` goes
/// false and the boundary turns that into a structured error instead of
/// emitting `NaN`, which is not JSON and would fail at the consumer's parse.
class ObjectWriter {
  public:
    ObjectWriter();
    ObjectWriter& number(const char* key, double value);
    ObjectWriter& integer(const char* key, long long value);
    ObjectWriter& boolean(const char* key, bool value);
    ObjectWriter& string(const char* key, std::string_view value);
    ObjectWriter& vec3(const char* key, const double value[3]);
    ObjectWriter& numbers(const char* key, const double* values, std::size_t count);
    /// Splice a already-serialised JSON fragment (object/array) under `key`.
    ObjectWriter& raw(const char* key, std::string_view json);

    bool ok() const { return ok_; }
    /// Marks the document as unrepresentable; the boundary reports the reason.
    void invalidate() { ok_ = false; }
    std::string finish();

  private:
    void comma();
    std::string buffer_;
    bool first_ = true;
    bool ok_ = true;
};

/// Serialise one double the way a JSON producer should: the SHORTEST decimal
/// form that reads back as the identical double. Matches what nlohmann and
/// JSON.stringify emit, so recorded transcripts stay textually stable across
/// this library swap.
std::string numberToString(double value);

/// JSON string escaping (quotes included).
std::string quote(std::string_view text);

}  // namespace json_lite
}  // namespace maneuver

#endif  // MANEUVER_JSON_LITE_H
