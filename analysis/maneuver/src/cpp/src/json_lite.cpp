#include "maneuver/json_lite.h"

#include "maneuver/fault.h"

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <limits>
#include <string>

namespace maneuver {
namespace json_lite {

const Value* Value::find(std::string_view key) const {
    if (kind != Kind::Object) return nullptr;
    for (const auto& member : members) {
        if (member.first.size() == key.size() &&
            std::memcmp(member.first.data(), key.data(), key.size()) == 0) {
            return &member.second;
        }
    }
    return nullptr;
}

namespace {

struct Parser {
    std::string_view text;
    std::size_t pos = 0;
    std::string error;

    bool fail(const char* why) {
        if (error.empty()) {
            error = std::string(why) + " at offset " + std::to_string(pos);
        }
        return false;
    }

    void skipWhitespace() {
        while (pos < text.size()) {
            const char c = text[pos];
            if (c == ' ' || c == '\t' || c == '\n' || c == '\r') {
                ++pos;
            } else {
                break;
            }
        }
    }

    bool literal(const char* word) {
        const std::size_t length = std::strlen(word);
        if (text.size() - pos < length) return fail("truncated literal");
        if (std::memcmp(text.data() + pos, word, length) != 0) {
            return fail("unknown literal");
        }
        pos += length;
        return true;
    }

    /// Read a JSON string body (opening quote already consumed on entry).
    bool readString(std::string* out) {
        out->clear();
        while (true) {
            if (pos >= text.size()) return fail("unterminated string");
            const unsigned char c = static_cast<unsigned char>(text[pos]);
            if (c == '"') {
                ++pos;
                return true;
            }
            if (c < 0x20) return fail("control character in string");
            if (c != '\\') {
                out->push_back(static_cast<char>(c));
                ++pos;
                continue;
            }
            ++pos;
            if (pos >= text.size()) return fail("truncated escape");
            const char esc = text[pos++];
            switch (esc) {
                case '"': out->push_back('"'); break;
                case '\\': out->push_back('\\'); break;
                case '/': out->push_back('/'); break;
                case 'b': out->push_back('\b'); break;
                case 'f': out->push_back('\f'); break;
                case 'n': out->push_back('\n'); break;
                case 'r': out->push_back('\r'); break;
                case 't': out->push_back('\t'); break;
                case 'u': {
                    if (text.size() - pos < 4) return fail("truncated \\u escape");
                    unsigned int code = 0;
                    for (int i = 0; i < 4; ++i) {
                        const char h = text[pos + i];
                        unsigned int digit;
                        if (h >= '0' && h <= '9') digit = static_cast<unsigned int>(h - '0');
                        else if (h >= 'a' && h <= 'f') digit = static_cast<unsigned int>(h - 'a' + 10);
                        else if (h >= 'A' && h <= 'F') digit = static_cast<unsigned int>(h - 'A' + 10);
                        else return fail("bad \\u escape");
                        code = (code << 4) | digit;
                    }
                    pos += 4;
                    // Encode as UTF-8. Surrogate halves are passed through as
                    // the replacement character rather than rejected: this
                    // module never interprets string content beyond the
                    // operation name, and a lone surrogate is not a reason to
                    // refuse an otherwise well-formed request.
                    if (code >= 0xD800 && code <= 0xDFFF) code = 0xFFFD;
                    if (code < 0x80) {
                        out->push_back(static_cast<char>(code));
                    } else if (code < 0x800) {
                        out->push_back(static_cast<char>(0xC0 | (code >> 6)));
                        out->push_back(static_cast<char>(0x80 | (code & 0x3F)));
                    } else {
                        out->push_back(static_cast<char>(0xE0 | (code >> 12)));
                        out->push_back(static_cast<char>(0x80 | ((code >> 6) & 0x3F)));
                        out->push_back(static_cast<char>(0x80 | (code & 0x3F)));
                    }
                    break;
                }
                default:
                    return fail("unknown escape");
            }
        }
    }

    /// JSON number grammar, validated BEFORE strtod sees it. strtod accepts
    /// "inf", "nan", "0x1p3" and leading '+' — none of which are JSON, and
    /// "inf" arriving as a parameter is exactly the hostile value that used to
    /// propagate into the physics and out again as an unserialisable result.
    bool readNumber(double* out) {
        const std::size_t start = pos;
        if (pos < text.size() && text[pos] == '-') ++pos;
        if (pos >= text.size()) return fail("truncated number");
        if (text[pos] == '0') {
            ++pos;
        } else if (text[pos] >= '1' && text[pos] <= '9') {
            while (pos < text.size() && text[pos] >= '0' && text[pos] <= '9') ++pos;
        } else {
            return fail("number must start with a digit");
        }
        if (pos < text.size() && text[pos] == '.') {
            ++pos;
            if (pos >= text.size() || text[pos] < '0' || text[pos] > '9') {
                return fail("fraction needs a digit");
            }
            while (pos < text.size() && text[pos] >= '0' && text[pos] <= '9') ++pos;
        }
        if (pos < text.size() && (text[pos] == 'e' || text[pos] == 'E')) {
            ++pos;
            if (pos < text.size() && (text[pos] == '+' || text[pos] == '-')) ++pos;
            if (pos >= text.size() || text[pos] < '0' || text[pos] > '9') {
                return fail("exponent needs a digit");
            }
            while (pos < text.size() && text[pos] >= '0' && text[pos] <= '9') ++pos;
        }
        const std::string token(text.substr(start, pos - start));
        const char* begin = token.c_str();
        char* end = nullptr;
        const double value = std::strtod(begin, &end);
        if (end != begin + token.size()) return fail("unreadable number");
        // Overflow ("1e400") comes back as +-HUGE_VAL. A request cannot carry a
        // number that is not a number.
        if (!std::isfinite(value)) return fail("number out of range");
        *out = value;
        return true;
    }

    bool readValue(Value* out, int depth) {
        if (depth > kMaxDepth) return fail("nesting too deep");
        skipWhitespace();
        if (pos >= text.size()) return fail("unexpected end of input");
        const char c = text[pos];
        switch (c) {
            case 'n':
                if (!literal("null")) return false;
                out->kind = Kind::Null;
                return true;
            case 't':
                if (!literal("true")) return false;
                out->kind = Kind::Bool;
                out->boolean = true;
                return true;
            case 'f':
                if (!literal("false")) return false;
                out->kind = Kind::Bool;
                out->boolean = false;
                return true;
            case '"': {
                ++pos;
                out->kind = Kind::String;
                return readString(&out->text);
            }
            case '[': {
                ++pos;
                out->kind = Kind::Array;
                skipWhitespace();
                if (pos < text.size() && text[pos] == ']') {
                    ++pos;
                    return true;
                }
                while (true) {
                    out->items.emplace_back();
                    if (!readValue(&out->items.back(), depth + 1)) return false;
                    skipWhitespace();
                    if (pos >= text.size()) return fail("unterminated array");
                    if (text[pos] == ',') {
                        ++pos;
                        continue;
                    }
                    if (text[pos] == ']') {
                        ++pos;
                        return true;
                    }
                    return fail("expected ',' or ']'");
                }
            }
            case '{': {
                ++pos;
                out->kind = Kind::Object;
                skipWhitespace();
                if (pos < text.size() && text[pos] == '}') {
                    ++pos;
                    return true;
                }
                while (true) {
                    skipWhitespace();
                    if (pos >= text.size() || text[pos] != '"') {
                        return fail("expected a member name");
                    }
                    ++pos;
                    std::string key;
                    if (!readString(&key)) return false;
                    skipWhitespace();
                    if (pos >= text.size() || text[pos] != ':') {
                        return fail("expected ':'");
                    }
                    ++pos;
                    out->members.emplace_back(std::move(key), Value{});
                    if (!readValue(&out->members.back().second, depth + 1)) return false;
                    skipWhitespace();
                    if (pos >= text.size()) return fail("unterminated object");
                    if (text[pos] == ',') {
                        ++pos;
                        continue;
                    }
                    if (text[pos] == '}') {
                        ++pos;
                        return true;
                    }
                    return fail("expected ',' or '}'");
                }
            }
            default:
                if (c == '-' || (c >= '0' && c <= '9')) {
                    out->kind = Kind::Number;
                    return readNumber(&out->number);
                }
                return fail("unexpected character");
        }
    }
};

std::string describe(const char* operation, const char* key) {
    return std::string("[") + operation + "]: parameter \"" + key + "\"";
}

}  // namespace

bool parse(std::string_view text, Value* out, std::string* error) {
    Parser parser;
    parser.text = text;
    if (!parser.readValue(out, 0)) {
        if (error) *error = parser.error;
        return false;
    }
    parser.skipWhitespace();
    if (parser.pos != text.size()) {
        if (error) {
            *error = "trailing content at offset " + std::to_string(parser.pos);
        }
        return false;
    }
    return true;
}

// ---------------------------------------------------------------------------
// Guarded readers
// ---------------------------------------------------------------------------

bool requireNumber(const Value& object, const char* key, const char* operation,
                   double* out) {
    const Value* found = object.find(key);
    if (found == nullptr) {
        fault::raise(fault_code::INVALID_PARAMETER,
                     describe(operation, key) + " is required and was not supplied");
        return false;
    }
    if (!found->isNumber()) {
        fault::raise(fault_code::INVALID_PARAMETER,
                     describe(operation, key) + " must be a number");
        return false;
    }
    *out = found->number;
    return true;
}

bool requirePositive(const Value& object, const char* key,
                     const char* operation, double* out) {
    if (!requireNumber(object, key, operation, out)) return false;
    if (!(*out > 0.0)) {
        fault::raise(fault_code::INVALID_PARAMETER,
                     describe(operation, key) + " must be positive (got " +
                         numberToString(*out) + ")");
        return false;
    }
    return true;
}

bool optionalNumber(const Value& object, const char* key,
                    const char* operation, double* out) {
    const Value* found = object.find(key);
    if (found == nullptr || found->isNull()) return true;
    if (!found->isNumber()) {
        fault::raise(fault_code::INVALID_PARAMETER,
                     describe(operation, key) + " must be a number when present");
        return false;
    }
    *out = found->number;
    return true;
}

bool optionalPositive(const Value& object, const char* key,
                      const char* operation, double* out) {
    if (!optionalNumber(object, key, operation, out)) return false;
    if (!(*out > 0.0)) {
        fault::raise(fault_code::INVALID_PARAMETER,
                     describe(operation, key) + " must be positive (got " +
                         numberToString(*out) + ")");
        return false;
    }
    return true;
}

bool requireInt(const Value& object, const char* key, const char* operation,
                int* out) {
    double value = 0.0;
    if (!requireNumber(object, key, operation, &value)) return false;
    if (value != std::floor(value) || value < -2147483648.0 ||
        value > 2147483647.0) {
        fault::raise(fault_code::INVALID_PARAMETER,
                     describe(operation, key) + " must be a 32-bit integer (got " +
                         numberToString(value) + ")");
        return false;
    }
    *out = static_cast<int>(value);
    return true;
}

bool optionalInt(const Value& object, const char* key, const char* operation,
                 int* out) {
    const Value* found = object.find(key);
    if (found == nullptr || found->isNull()) return true;
    return requireInt(object, key, operation, out);
}

bool optionalBool(const Value& object, const char* key, const char* operation,
                  bool* out) {
    const Value* found = object.find(key);
    if (found == nullptr || found->isNull()) return true;
    if (!found->isBool()) {
        fault::raise(fault_code::INVALID_PARAMETER,
                     describe(operation, key) + " must be true or false");
        return false;
    }
    *out = found->boolean;
    return true;
}

bool optionalString(const Value& object, const char* key,
                    const char* operation, std::string* out) {
    const Value* found = object.find(key);
    if (found == nullptr || found->isNull()) return true;
    if (!found->isString()) {
        fault::raise(fault_code::INVALID_PARAMETER,
                     describe(operation, key) + " must be a string");
        return false;
    }
    *out = found->text;
    return true;
}

bool requireVec3(const Value& object, const char* key, const char* operation,
                 double out[3]) {
    const Value* found = object.find(key);
    if (found == nullptr) {
        fault::raise(fault_code::INVALID_PARAMETER,
                     describe(operation, key) +
                         " is required and was not supplied (expected an array of 3 numbers)");
        return false;
    }
    if (!found->isArray() || found->items.size() != 3) {
        fault::raise(fault_code::INVALID_PARAMETER,
                     describe(operation, key) + " must be an array of exactly 3 numbers");
        return false;
    }
    for (int axis = 0; axis < 3; ++axis) {
        if (!found->items[static_cast<std::size_t>(axis)].isNumber()) {
            fault::raise(fault_code::INVALID_PARAMETER,
                         describe(operation, key) + " component " +
                             std::to_string(axis) + " must be a number");
            return false;
        }
        out[axis] = found->items[static_cast<std::size_t>(axis)].number;
    }
    return true;
}

bool optionalVec3(const Value& object, const char* key, const char* operation,
                  double out[3], bool* present) {
    const Value* found = object.find(key);
    if (found == nullptr || found->isNull()) {
        if (present) *present = false;
        return true;
    }
    if (!requireVec3(object, key, operation, out)) return false;
    if (present) *present = true;
    return true;
}

bool requireObject(const Value& object, const char* key, const char* operation,
                   const Value** out) {
    const Value* found = object.find(key);
    if (found == nullptr) {
        fault::raise(fault_code::INVALID_PARAMETER,
                     describe(operation, key) + " is required and was not supplied");
        return false;
    }
    if (!found->isObject()) {
        fault::raise(fault_code::INVALID_PARAMETER,
                     describe(operation, key) + " must be an object");
        return false;
    }
    *out = found;
    return true;
}

bool requireArray(const Value& object, const char* key, const char* operation,
                  const Value** out) {
    const Value* found = object.find(key);
    if (found == nullptr) {
        fault::raise(fault_code::INVALID_PARAMETER,
                     describe(operation, key) + " is required and was not supplied");
        return false;
    }
    if (!found->isArray()) {
        fault::raise(fault_code::INVALID_PARAMETER,
                     describe(operation, key) + " must be an array");
        return false;
    }
    *out = found;
    return true;
}

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

std::string numberToString(double value) {
    if (!std::isfinite(value)) {
        // Never reachable through ObjectWriter, which refuses first. Present so
        // that a direct caller gets valid JSON rather than "nan".
        return "null";
    }
    if (value == static_cast<double>(static_cast<long long>(value)) &&
        std::abs(value) < 1e15) {
        return std::to_string(static_cast<long long>(value));
    }
    char buffer[64];
    for (int precision = 15; precision <= 17; ++precision) {
        std::snprintf(buffer, sizeof(buffer), "%.*g", precision, value);
        if (std::strtod(buffer, nullptr) == value) break;
    }
    return std::string(buffer);
}

std::string quote(std::string_view text) {
    std::string out;
    out.reserve(text.size() + 2);
    out.push_back('"');
    for (const char raw : text) {
        const unsigned char c = static_cast<unsigned char>(raw);
        switch (c) {
            case '"': out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\b': out += "\\b"; break;
            case '\f': out += "\\f"; break;
            case '\n': out += "\\n"; break;
            case '\r': out += "\\r"; break;
            case '\t': out += "\\t"; break;
            default:
                if (c < 0x20) {
                    char escape[8];
                    std::snprintf(escape, sizeof(escape), "\\u%04x", c);
                    out += escape;
                } else {
                    out.push_back(raw);
                }
        }
    }
    out.push_back('"');
    return out;
}

ObjectWriter::ObjectWriter() { buffer_.push_back('{'); }

void ObjectWriter::comma() {
    if (!first_) buffer_.push_back(',');
    first_ = false;
}

ObjectWriter& ObjectWriter::number(const char* key, double value) {
    if (!std::isfinite(value)) {
        ok_ = false;
        return *this;
    }
    comma();
    buffer_ += quote(key);
    buffer_.push_back(':');
    buffer_ += numberToString(value);
    return *this;
}

ObjectWriter& ObjectWriter::integer(const char* key, long long value) {
    comma();
    buffer_ += quote(key);
    buffer_.push_back(':');
    buffer_ += std::to_string(value);
    return *this;
}

ObjectWriter& ObjectWriter::boolean(const char* key, bool value) {
    comma();
    buffer_ += quote(key);
    buffer_.push_back(':');
    buffer_ += value ? "true" : "false";
    return *this;
}

ObjectWriter& ObjectWriter::string(const char* key, std::string_view value) {
    comma();
    buffer_ += quote(key);
    buffer_.push_back(':');
    buffer_ += quote(value);
    return *this;
}

ObjectWriter& ObjectWriter::vec3(const char* key, const double value[3]) {
    return numbers(key, value, 3);
}

ObjectWriter& ObjectWriter::numbers(const char* key, const double* values,
                                    std::size_t count) {
    for (std::size_t i = 0; i < count; ++i) {
        if (!std::isfinite(values[i])) {
            ok_ = false;
            return *this;
        }
    }
    comma();
    buffer_ += quote(key);
    buffer_ += ":[";
    for (std::size_t i = 0; i < count; ++i) {
        if (i != 0) buffer_.push_back(',');
        buffer_ += numberToString(values[i]);
    }
    buffer_.push_back(']');
    return *this;
}

ObjectWriter& ObjectWriter::raw(const char* key, std::string_view json) {
    comma();
    buffer_ += quote(key);
    buffer_.push_back(':');
    buffer_.append(json.data(), json.size());
    return *this;
}

std::string ObjectWriter::finish() {
    buffer_.push_back('}');
    return buffer_;
}

}  // namespace json_lite
}  // namespace maneuver
