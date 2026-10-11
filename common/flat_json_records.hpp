#pragma once
// common/flat_json_records.hpp: a JSON array of flat objects (or JSON lines of them), one object at a time.
//
// Provider catalogs are tens of megabytes of records that are flat objects of text, numbers and nulls.
// Building a DOM of one would hold ten times the input in memory, so nlohmann/json's SAX parser (the
// JSON library this repository vendors) hands each object to the caller as soon as it closes. A value
// nested inside a record (an array or an object) is not materialized: the record counts it and goes on.
//
// REQUIRES nlohmann/json to be included first, with JSON_NOEXCEPTION defined: a malformed input comes
// back as a false return and a message, never as an exception.
#include <cstddef>
#include <string>
#include <utility>
#include <vector>

namespace flatjson {

struct Value {
  enum Kind { Null, Bool, Integer, Float, String };
  Kind kind = Null;
  // String: the decoded text. Integer: its digits. Float: the number as written in the source.
  // Bool: "true" or "false".
  std::string text;
  double number = 0.0;
};

struct Record {
  std::vector<std::pair<std::string, Value>> fields;  // in source order
  size_t nested = 0;                                   // nested values left out
  const Value* find(const char* key) const {
    for (const auto& field : fields) {
      if (field.first == key) return &field.second;
    }
    return nullptr;
  }
  // The text of a string, integer or float field; empty for a missing or null field.
  std::string text(const char* key) const {
    const Value* v = find(key);
    return v && v->kind != Value::Null ? v->text : std::string();
  }
};

namespace detail {

template <class F>
class Handler : public nlohmann::json::json_sax_t {
 public:
  using string_t = nlohmann::json::string_t;
  using binary_t = nlohmann::json::binary_t;
  Handler(F& on_record, bool array_mode, std::string* error) : on_record_(on_record), record_level_(array_mode ? 1 : 0), array_mode_(array_mode), error_(error) {}

  bool null() override { return value(Value{Value::Null, "", 0.0}); }
  bool boolean(bool v) override { return value(Value{Value::Bool, v ? "true" : "false", v ? 1.0 : 0.0}); }
  bool number_integer(nlohmann::json::number_integer_t v) override { return value(Value{Value::Integer, std::to_string(v), static_cast<double>(v)}); }
  bool number_unsigned(nlohmann::json::number_unsigned_t v) override { return value(Value{Value::Integer, std::to_string(v), static_cast<double>(v)}); }
  bool number_float(nlohmann::json::number_float_t v, const string_t& source) override { return value(Value{Value::Float, source, v}); }
  bool string(string_t& v) override { return value(Value{Value::String, v, 0.0}); }
  bool binary(binary_t&) override { return fail("binary values are not JSON"); }

  bool start_object(std::size_t) override {
    if (level_ == record_level_ && !in_record_) {
      in_record_ = true;
      record_ = Record();
      ++level_;
      return true;
    }
    if (!in_record_) return fail(array_mode_ ? "an array element is not an object" : "a line is not an object");
    ++record_.nested;
    ++level_;
    return true;
  }
  bool key(string_t& k) override {
    if (in_record_ && level_ == record_level_ + 1) key_ = k;
    return true;
  }
  bool end_object() override {
    --level_;
    if (in_record_ && level_ == record_level_) {
      in_record_ = false;
      ++records_;
      return on_record_(record_);
    }
    return true;
  }
  bool start_array(std::size_t) override {
    if (!in_record_) {
      if (array_mode_ && level_ == 0 && !opened_) {
        opened_ = true;
        ++level_;
        return true;
      }
      return fail("the input is not a JSON array of objects");
    }
    ++record_.nested;
    ++level_;
    return true;
  }
  bool end_array() override {
    --level_;
    return true;
  }
  bool parse_error(std::size_t position, const std::string&, const nlohmann::json::exception& e) override {
    if (error_->empty()) *error_ = std::string("malformed JSON at byte ") + std::to_string(position) + ": " + e.what();
    return false;
  }
  size_t records() const { return records_; }
  void next_line() { level_ = 0; in_record_ = false; }

 private:
  bool value(Value v) {
    if (!in_record_) return fail("a value outside any record");
    if (level_ == record_level_ + 1) record_.fields.emplace_back(key_, std::move(v));
    else ++record_.nested;
    return true;
  }
  bool fail(const char* message) {
    if (error_->empty()) *error_ = message;
    return false;
  }
  F& on_record_;
  size_t record_level_;
  bool array_mode_;
  std::string* error_;
  size_t level_ = 0;
  bool in_record_ = false, opened_ = false;
  std::string key_;
  Record record_;
  size_t records_ = 0;
};

}  // namespace detail

// Calls `on_record(const Record&)` for each object, in order; a false return stops the read (the
// caller has set its own message). Returns false with `*error` set for malformed input or when the
// caller stops. An input whose first non-space byte is '[' is one array; otherwise it is JSON lines.
template <class F>
bool for_each_record(const char* data, size_t length, F&& on_record, std::string* error) {
  size_t start = 0;
  while (start < length && (data[start] == ' ' || data[start] == '\t' || data[start] == '\r' || data[start] == '\n')) ++start;
  if (start == length) {
    *error = "the input is empty";
    return false;
  }
  if (data[start] == '[') {
    detail::Handler<F> handler(on_record, true, error);
    const bool ok = nlohmann::json::sax_parse(data + start, data + length, &handler, nlohmann::json::input_format_t::json, true, false);
    if (!ok && error->empty()) *error = "the JSON array could not be read";
    return ok;
  }
  size_t line_no = 0;
  for (size_t at = start; at < length;) {
    size_t end = at;
    while (end < length && data[end] != '\n') ++end;
    size_t last = end;
    while (last > at && (data[last - 1] == '\r' || data[last - 1] == ' ' || data[last - 1] == '\t')) --last;
    ++line_no;
    if (last > at) {
      detail::Handler<F> handler(on_record, false, error);
      const bool ok = nlohmann::json::sax_parse(data + at, data + last, &handler, nlohmann::json::input_format_t::json, true, false);
      if (!ok) {
        if (error->empty()) *error = "a line could not be read";
        *error += " (line " + std::to_string(line_no) + ")";
        return false;
      }
    }
    at = end + 1;
  }
  return true;
}

}  // namespace flatjson
