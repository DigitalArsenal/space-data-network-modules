// C++ guest-side hostcall as an SDS $PIV invocation (module -> host), replacing the JSON meta + binary segments
// envelope: PIVRequest.METHOD_ID is the operation and PAYLOAD_ARENA holds its frames, named by TAB.PORT_ID - the
// "params" aligned record (schemas/runtime/HostOps.fbs, FlatBuffers aligned binary layout), list ports (runs of aligned
// records) and raw ports (unbounded bytes: bodies, record streams, urls, sql). The PIVResponse carries the "result"
// record and the operation's list / raw ports, or STATUS FAILED with ERROR_CODE / ERROR_MESSAGE. HOST_OPERATIONS in
// src/standards/runtimeContracts.js names each operation's frames. The same space_data_module_host.call import carries it.
//
// Include paths: the SDK-generated "sds/PIV/main_generated.h" (as every SDK-compiled module has), the runtime headers
// (src/generated/runtime/cpp: HostOps_aligned.h) and flatbuffers.
//
//   sdn::runtime::Aligned::StorageExpireParams p{};
//   sdm_piv::put(p.SCHEMA, "WXF.fbs"); p.set_has_SCHEMA(true);
//   p.BEFORE_MS = cutoff_ms;
//   auto r = sdm_piv::call("storage.expire", "StorageExpireParams", p);
//   if (const auto* out = r.result<sdn::runtime::Aligned::StorageExpireResult>()) { out->DELETED; } else { r.error_message(); }
//
//   auto get = sdm_piv::call("http.request", "HttpParams", http, {sdm_piv::raw("url", url)});
//   std::string_view body = get.raw("body");
//
//   const sdm_piv::Config config = sdm_piv::get_config();   // plugin.getConfig: one ModuleConfig (MCFG), read in place
//   if (!config.ok()) { config.error_message(); }
//   double lead = config.number("nwp_max_lead", 72);
//   std::string_view provider = config.string("targets.0.provider_id");
//   sdm_piv::Span<double> index = config.numbers("index");
#ifndef SDM_PIV_HOSTCALL_HPP
#define SDM_PIV_HOSTCALL_HPP

#include <cstdint>
#include <cstring>
#include <initializer_list>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "sds/PIV/main_generated.h"
#include "HostOps_aligned.h"
#include "ModuleConfig_generated.h"

extern "C" {
#if defined(__wasm__)
__attribute__((import_module("space_data_module_host"), import_name("call")))
#endif
int32_t sdm_piv_host_call(const uint8_t* op_ptr, int32_t op_len, const uint8_t* payload_ptr, int32_t payload_len);
#if defined(__wasm__)
__attribute__((import_module("space_data_module_host"), import_name("response_len")))
#endif
int32_t sdm_piv_host_response_len(void);
#if defined(__wasm__)
__attribute__((import_module("space_data_module_host"), import_name("read_response")))
#endif
int32_t sdm_piv_host_read_response(uint8_t* dst_ptr, int32_t dst_len);
}

namespace sdm_piv {

constexpr uint32_t kArenaAlignment = 8;  // the SDK invoke codec's PAYLOAD_ARENA alignment (INVOKE_ARENA_ALIGNMENT)
constexpr const char* kHostOpsSchema = "HostOps.fbs";

/// Set an aligned string; false (and the field left empty) when the value does not fit - never truncated.
template <size_t N>
inline bool put(flatbuffers::aligned_runtime::AlignedString<N>& field, std::string_view value) {
  if (value.size() > N) { field.clear(); return false; }
  field.set(std::string(value));
  return true;
}

/// A frame of the call: an aligned record or a run of them (root_type set), or raw bytes (root_type null).
struct Frame {
  const char* port;
  const uint8_t* data;
  size_t size;
  const char* root_type = nullptr;
  uint32_t byte_length = 0;  // the record stride; 0 = a run of records (a variable-length aligned stream)
  uint16_t alignment = 1;
};
inline Frame raw(const char* port, std::string_view bytes) {
  return {port, reinterpret_cast<const uint8_t*>(bytes.data()), bytes.size()};
}
inline Frame raw(const char* port, const uint8_t* data, size_t size) { return {port, data, size}; }
/// A list port: `count` records of T back to back.
template <typename T>
inline Frame list(const char* port, const char* root_type, const T* items, size_t count) {
  return {port, reinterpret_cast<const uint8_t*>(items), sizeof(T) * count, root_type, 0, static_cast<uint16_t>(alignof(T))};
}

/// The host's $PIV response.
class Response {
 public:
  explicit Response(std::vector<uint8_t> bytes, std::string transport_error = {})
      : bytes_(std::move(bytes)), error_(std::move(transport_error)) {
    if (!error_.empty()) return;
    flatbuffers::Verifier verifier(bytes_.data(), bytes_.size());
    if (!VerifyPIVBuffer(verifier) || !GetPIV(bytes_.data())->RESPONSE()) error_ = "host answered without a $PIV response";
  }
  const PIVResponse* get() const { return error_.empty() ? GetPIV(bytes_.data())->RESPONSE() : nullptr; }
  bool ok() const { const auto* r = get(); return r && r->STATUS() == pivStatus_OK && !r->ERROR_CODE(); }
  std::string error_code() const {
    const auto* r = get();
    return !r ? "failed" : r->ERROR_CODE() ? r->ERROR_CODE()->str() : (ok() ? "" : "failed");
  }
  std::string error_message() const {
    if (!error_.empty()) return error_;
    const auto* r = get();
    return r && r->ERROR_MESSAGE() ? r->ERROR_MESSAGE()->str() : std::string();
  }
  /// The bytes of output port `port` (empty when the call failed or the port is absent).
  std::string_view raw(const char* port) const {
    const auto [data, size] = frame(port, nullptr);
    return {reinterpret_cast<const char*>(data), size};
  }
  /// The "result" record as T, read in place (nullptr when the call failed or the frame is not one T).
  template <typename T>
  const T* result(const char* root_type = nullptr) const {
    const auto [data, size] = frame("result", root_type);
    return data && size == sizeof(T) && reinterpret_cast<uintptr_t>(data) % alignof(T) == 0 ? T::fromBytes(data) : nullptr;
  }
  /// A list port as `count` records of T, read in place.
  template <typename T>
  std::pair<const T*, size_t> list(const char* port, const char* root_type = nullptr) const {
    const auto [data, size] = frame(port, root_type);
    if (!data || size % sizeof(T) || reinterpret_cast<uintptr_t>(data) % alignof(T)) return {nullptr, 0};
    return {T::fromBytes(data), size / sizeof(T)};
  }

 private:
  std::pair<const uint8_t*, size_t> frame(const char* port, const char* root_type) const {
    const auto* r = get();
    if (!ok() || !r->OUTPUTS() || !r->PAYLOAD_ARENA()) return {nullptr, 0};
    for (const auto* tab : *r->OUTPUTS()) {
      if (!tab->PORT_ID() || tab->PORT_ID()->str() != port) continue;
      if (root_type && (!tab->TYPE_REF() || !tab->TYPE_REF()->ROOT_TYPE() || tab->TYPE_REF()->ROOT_TYPE()->str() != root_type)) return {nullptr, 0};
      const uint64_t end = static_cast<uint64_t>(tab->OFFSET()) + tab->SIZE();
      if (end > r->PAYLOAD_ARENA()->size()) return {nullptr, 0};
      return {r->PAYLOAD_ARENA()->data() + tab->OFFSET(), tab->SIZE()};
    }
    return {nullptr, 0};
  }
  std::vector<uint8_t> bytes_;
  std::string error_;
};

/// Call an operation with its frames (the "params" record first when it takes one - see call() below).
inline Response call_frames(const char* op, const std::vector<Frame>& frames) {
  std::vector<uint8_t> arena;
  std::vector<TABT> tabs;
  for (const Frame& f : frames) {
    const uint32_t align = f.alignment > kArenaAlignment ? f.alignment : kArenaAlignment;
    arena.resize((arena.size() + align - 1) / align * align, 0);
    TABT tab;
    tab.OFFSET = static_cast<uint32_t>(arena.size());
    tab.SIZE = static_cast<uint32_t>(f.size);
    tab.ALIGNMENT = align;
    tab.PORT_ID = f.port;
    if (f.root_type) {
      tab.WIRE_FORMAT = payloadWireFormat_ALIGNED_BINARY;
      tab.TYPE_REF = std::make_unique<FlatBufferTypeRefT>();
      tab.TYPE_REF->SCHEMA_NAME = kHostOpsSchema;
      tab.TYPE_REF->ROOT_TYPE = f.root_type;
      tab.TYPE_REF->WIRE_FORMAT = payloadWireFormat_ALIGNED_BINARY;
      tab.TYPE_REF->BYTE_LENGTH = f.byte_length;
      tab.TYPE_REF->REQUIRED_ALIGNMENT = f.alignment;
    }
    arena.insert(arena.end(), f.data, f.data + f.size);
    tabs.push_back(std::move(tab));
  }
  flatbuffers::FlatBufferBuilder b(arena.size() + 256 * (tabs.size() + 1));
  flatbuffers::Offset<flatbuffers::Vector<uint8_t>> arena_vector;
  if (!arena.empty()) {
    b.ForceVectorAlignment(arena.size(), sizeof(uint8_t), kArenaAlignment);
    arena_vector = b.CreateVector(arena);
  }
  std::vector<flatbuffers::Offset<TAB>> inputs;
  for (const TABT& tab : tabs) inputs.push_back(CreateTAB(b, &tab));
  const auto inputs_vector = b.CreateVector(inputs);
  const auto method = b.CreateString(op);
  PIVRequestBuilder request(b);
  request.add_METHOD_ID(method);
  request.add_INPUTS(inputs_vector);
  if (!arena.empty()) request.add_PAYLOAD_ARENA(arena_vector);
  const auto request_offset = request.Finish();
  PIVBuilder piv(b);
  piv.add_REQUEST(request_offset);
  FinishPIVBuffer(b, piv.Finish());

  sdm_piv_host_call(reinterpret_cast<const uint8_t*>(op), static_cast<int32_t>(std::strlen(op)), b.GetBufferPointer(),
                    static_cast<int32_t>(b.GetSize()));
  const int32_t len = sdm_piv_host_response_len();
  if (len <= 0) return Response({}, "host returned no response");
  std::vector<uint8_t> bytes(static_cast<size_t>(len));
  if (sdm_piv_host_read_response(bytes.data(), len) != len) return Response({}, "host response was truncated");
  return Response(std::move(bytes));
}

/// Call an operation with its "params" record (aligned type `params_type`) and any list / raw frames.
template <typename Params>
inline Response call(const char* op, const char* params_type, const Params& params, std::initializer_list<Frame> more = {}) {
  std::vector<Frame> frames{{"params", reinterpret_cast<const uint8_t*>(&params), sizeof(Params), params_type,
                             static_cast<uint32_t>(sizeof(Params)), static_cast<uint16_t>(alignof(Params))}};
  frames.insert(frames.end(), more.begin(), more.end());
  return call_frames(op, frames);
}
/// Call an operation without a "params" record (clock.now, plugin.getConfig, filesystem.readFile with raw "path", ...).
inline Response call(const char* op, std::initializer_list<Frame> frames = {}) { return call_frames(op, std::vector<Frame>(frames)); }

// ---- plugin.getConfig: the module's config as one ModuleConfig FlatBuffer (schemas/runtime/ModuleConfig.fbs, MCFG) --

/// A read-only run of T in place (C++17 has no std::span).
template <typename T>
class Span {
 public:
  Span() = default;
  Span(const T* data, size_t size) : data_(data), size_(size) {}
  const T* data() const { return data_; }
  size_t size() const { return size_; }
  bool empty() const { return size_ == 0; }
  const T& operator[](size_t i) const { return data_[i]; }
  const T* begin() const { return data_; }
  const T* end() const { return data_ + size_; }

 private:
  const T* data_ = nullptr;
  size_t size_ = 0;
};

using ConfigEntries = flatbuffers::Vector<flatbuffers::Offset<sdn::runtime::ConfigEntry>>;

/// A table of config entries (the ModuleConfig root, or one nested ConfigTable of a TableList), sorted by KEY.
///
/// Every lookup takes a key or a dotted path into nested tables and lists, the way the old flattened entries were
/// named: "targets.0.provider_id" (table 0 of TableList "targets", then its "provider_id"), "targets.provider_id"
/// (a TableList holding one table - a nested object - needs no index), "widths.1" (item 1 of a NumberList or
/// StringList). A key that itself contains dots is found too: the longest key that matches is taken first.
/// A missing key, or a value of another kind, answers the default (or an empty list / table).
class ConfigTable {
 public:
  ConfigTable() = default;
  explicit ConfigTable(const ConfigEntries* entries) : entries_(entries) {}

  explicit operator bool() const { return entries_ != nullptr; }
  /// The entries, in place (nullptr for an empty table).
  const ConfigEntries* entries() const { return entries_; }
  size_t size() const { return entries_ ? entries_->size() : 0; }

  /// The entry a key or dotted path names (nullptr when there is none; a path ending in a list index names the
  /// list's entry - use the typed lookups to read the item).
  const sdn::runtime::ConfigEntry* entry(std::string_view key) const { return find(key).entry; }
  bool has(std::string_view key) const { return find(key).entry != nullptr; }
  /// The value's kind, or `fallback` when the key is missing.
  sdn::runtime::configValueKind kind(std::string_view key, sdn::runtime::configValueKind fallback = sdn::runtime::configValueKind_String) const {
    const Found f = find(key);
    return f.entry ? f.entry->KIND() : fallback;
  }

  /// A String (or an item of a StringList: "names.2"); the view lives as long as the Config.
  std::string_view string(std::string_view key, std::string_view def = {}) const {
    const Found f = find(key);
    if (!f.entry) return def;
    if (f.index < 0 && f.entry->KIND() == sdn::runtime::configValueKind_String) return view(f.entry->STRING_VALUE());
    if (f.index >= 0 && f.entry->KIND() == sdn::runtime::configValueKind_StringList && f.entry->STRINGS() &&
        static_cast<size_t>(f.index) < f.entry->STRINGS()->size()) {
      return view(f.entry->STRINGS()->Get(static_cast<flatbuffers::uoffset_t>(f.index)));
    }
    return def;
  }
  /// A Number (or an item of a NumberList: "widths.1").
  double number(std::string_view key, double def = 0) const {
    const Found f = find(key);
    if (!f.entry) return def;
    if (f.index < 0 && f.entry->KIND() == sdn::runtime::configValueKind_Number) return f.entry->NUMBER_VALUE();
    if (f.index >= 0 && f.entry->KIND() == sdn::runtime::configValueKind_NumberList && f.entry->NUMBERS() &&
        static_cast<size_t>(f.index) < f.entry->NUMBERS()->size()) {
      return f.entry->NUMBERS()->Get(static_cast<flatbuffers::uoffset_t>(f.index));
    }
    return def;
  }
  bool boolean(std::string_view key, bool def = false) const {
    const Found f = find(key);
    return f.entry && f.index < 0 && f.entry->KIND() == sdn::runtime::configValueKind_Bool ? f.entry->BOOL_VALUE() : def;
  }
  /// A NumberList in place, no copy (empty when missing or another kind).
  Span<double> numbers(std::string_view key) const {
    const Found f = find(key);
    if (!f.entry || f.index >= 0 || f.entry->KIND() != sdn::runtime::configValueKind_NumberList || !f.entry->NUMBERS()) return {};
    return {f.entry->NUMBERS()->data(), f.entry->NUMBERS()->size()};
  }
  /// A StringList's items (views into the config; empty when missing or another kind).
  std::vector<std::string_view> strings(std::string_view key) const {
    std::vector<std::string_view> out;
    const Found f = find(key);
    if (!f.entry || f.index >= 0 || f.entry->KIND() != sdn::runtime::configValueKind_StringList || !f.entry->STRINGS()) return out;
    out.reserve(f.entry->STRINGS()->size());
    for (const auto* s : *f.entry->STRINGS()) out.push_back(view(s));
    return out;
  }
  /// How many items a list holds: a NumberList's numbers, a StringList's strings or a TableList's tables (0 when
  /// the key is missing or not a list). Iterate 0..count-1 instead of probing "key.N" until a lookup fails.
  size_t count(std::string_view key) const {
    const Found f = find(key);
    if (!f.entry || f.index >= 0) return 0;
    switch (f.entry->KIND()) {
      case sdn::runtime::configValueKind_NumberList: return f.entry->NUMBERS() ? f.entry->NUMBERS()->size() : 0;
      case sdn::runtime::configValueKind_StringList: return f.entry->STRINGS() ? f.entry->STRINGS()->size() : 0;
      case sdn::runtime::configValueKind_TableList: return f.entry->TABLES() ? f.entry->TABLES()->size() : 0;
      default: return 0;
    }
  }
  /// How many tables a TableList holds (0 when missing or another kind).
  size_t tables(std::string_view key) const {
    const Found f = find(key);
    return f.entry && f.index < 0 && f.entry->KIND() == sdn::runtime::configValueKind_TableList && f.entry->TABLES() ? f.entry->TABLES()->size() : 0;
  }
  /// Table `i` of a TableList ("targets", 2), or the table a path names ("targets.2"; "settings" for a nested object).
  ConfigTable table(std::string_view key, size_t i) const {
    const Found f = find(key);
    if (!f.entry || f.index >= 0 || f.entry->KIND() != sdn::runtime::configValueKind_TableList || !f.entry->TABLES() || i >= f.entry->TABLES()->size()) return {};
    return ConfigTable(f.entry->TABLES()->Get(static_cast<flatbuffers::uoffset_t>(i))->ENTRIES());
  }
  ConfigTable table(std::string_view key) const {
    const Found f = find(key);
    if (!f.entry || f.entry->KIND() != sdn::runtime::configValueKind_TableList || !f.entry->TABLES()) return {};
    const size_t i = f.index >= 0 ? static_cast<size_t>(f.index) : 0;
    if (i >= f.entry->TABLES()->size() || (f.index < 0 && f.entry->TABLES()->size() != 1)) return {};
    return ConfigTable(f.entry->TABLES()->Get(static_cast<flatbuffers::uoffset_t>(i))->ENTRIES());
  }

 private:
  struct Found {
    const sdn::runtime::ConfigEntry* entry = nullptr;
    int64_t index = -1;  // an item of a list, when the path ends in an index
  };
  static std::string_view view(const flatbuffers::String* s) { return s ? std::string_view(s->c_str(), s->size()) : std::string_view(); }
  static bool index_of(std::string_view s, int64_t& out) {
    if (s.empty() || s.size() > 18) return false;
    int64_t v = 0;
    for (char c : s) { if (c < '0' || c > '9') return false; v = v * 10 + (c - '0'); }
    out = v;
    return true;
  }
  /// The entry with exactly this key: a binary search (the entries are sorted by KEY), then a scan in case a writer
  /// sorted by another collation.
  static const sdn::runtime::ConfigEntry* lookup(const ConfigEntries* entries, std::string_view key) {
    if (!entries) return nullptr;
    size_t lo = 0, hi = entries->size();
    while (lo < hi) {
      const size_t mid = lo + (hi - lo) / 2;
      const auto* e = entries->Get(static_cast<flatbuffers::uoffset_t>(mid));
      const int c = view(e->KEY()).compare(key);
      if (c == 0) return e;
      if (c < 0) lo = mid + 1; else hi = mid;
    }
    for (const auto* e : *entries) if (view(e->KEY()) == key) return e;
    return nullptr;
  }
  static Found resolve(const ConfigEntries* entries, std::string_view path, int depth) {
    if (!entries || path.empty() || depth > 64) return {};
    if (const auto* e = lookup(entries, path)) return {e, -1};
    // the longest key before a dot first, so keys that contain dots win over nesting
    for (size_t dot = path.rfind('.'); dot != std::string_view::npos && dot > 0; dot = path.rfind('.', dot - 1)) {
      const auto* e = lookup(entries, path.substr(0, dot));
      if (!e) continue;
      std::string_view rest = path.substr(dot + 1);
      const size_t next = rest.find('.');
      const std::string_view head = rest.substr(0, next);
      int64_t index = -1;
      const bool indexed = index_of(head, index);
      switch (e->KIND()) {
        case sdn::runtime::configValueKind_NumberList:
        case sdn::runtime::configValueKind_StringList: {
          // an item past the end is missing, like any other missing key (modules find a list's end by probing)
          const size_t n = e->KIND() == sdn::runtime::configValueKind_NumberList ? (e->NUMBERS() ? e->NUMBERS()->size() : 0)
                                                                                 : (e->STRINGS() ? e->STRINGS()->size() : 0);
          if (indexed && next == std::string_view::npos && static_cast<uint64_t>(index) < n) return {e, index};
          return {};
        }
        case sdn::runtime::configValueKind_TableList: {
          const auto* tables = e->TABLES();
          if (!tables) return {};
          if (indexed) {
            if (static_cast<uint64_t>(index) >= tables->size()) return {};
            if (next == std::string_view::npos) return {e, index};  // "targets.0": the table itself
            return resolve(tables->Get(static_cast<flatbuffers::uoffset_t>(index))->ENTRIES(), rest.substr(next + 1), depth + 1);
          }
          if (tables->size() != 1) return {};
          return resolve(tables->Get(0)->ENTRIES(), rest, depth + 1);  // a nested object: one table, no index
        }
        default:
          return {};
      }
    }
    return {};
  }
  Found find(std::string_view key) const { return resolve(entries_, key, 0); }

  const ConfigEntries* entries_ = nullptr;
};

/// The module's config, as plugin.getConfig answers it: the host's $PIV response kept whole and its raw "config"
/// frame - one ModuleConfig FlatBuffer (MCFG) - verified and read in place. Lookups are ConfigTable's. Move-only
/// (the views point into the kept bytes).
class Config : public ConfigTable {
 public:
  explicit Config(Response response) : response_(std::move(response)) {
    if (!response_.ok()) { error_ = response_.error_message(); code_ = response_.error_code(); return; }
    std::string_view frame = response_.raw("config");
    if (frame.empty()) { fail("plugin.getConfig answered without a \"config\" frame"); return; }
    const uint8_t* data = reinterpret_cast<const uint8_t*>(frame.data());
    if (reinterpret_cast<uintptr_t>(data) % 8) {  // the invoke arena aligns frames to 8; copy only if a host did not
      aligned_.resize((frame.size() + 7) / 8);
      std::memcpy(aligned_.data(), frame.data(), frame.size());
      data = reinterpret_cast<const uint8_t*>(aligned_.data());
    }
    flatbuffers::Verifier::Options options;
    options.max_tables = 100000000;  // TableList-heavy configs: the buffer size bounds the work anyway
    flatbuffers::Verifier verifier(data, frame.size(), options);
    if (!sdn::runtime::VerifyModuleConfigBuffer(verifier)) { fail("plugin.getConfig: \"config\" is not a ModuleConfig (MCFG) FlatBuffer"); return; }
    root_ = sdn::runtime::GetModuleConfig(data);
    size_ = frame.size();
    static_cast<ConfigTable&>(*this) = ConfigTable(root_->ENTRIES());
  }
  Config(Config&&) = default;
  Config& operator=(Config&&) = default;
  Config(const Config&) = delete;
  Config& operator=(const Config&) = delete;

  bool ok() const { return root_ != nullptr; }
  std::string error_code() const { return code_; }
  std::string error_message() const { return error_; }
  /// The verified ModuleConfig root (nullptr when the call failed).
  const sdn::runtime::ModuleConfig* root() const { return root_; }
  /// The ModuleConfig bytes' length.
  size_t byte_size() const { return size_; }

 private:
  void fail(const char* message) { error_ = message; code_ = "failed"; }
  Response response_;
  std::vector<uint64_t> aligned_;
  const sdn::runtime::ModuleConfig* root_ = nullptr;
  size_t size_ = 0;
  std::string error_;
  std::string code_;
};

/// plugin.getConfig: the module's config (no capability needed).
inline Config get_config() { return Config(call("plugin.getConfig")); }

/// SQL values (raw "params" of storage.flatsql_query_stream / query_sandboxed / flatsql_cache_key, raw "cells" of a
/// query_sandboxed rows answer) in FlatSQL's tagged parameter encoding: value after value, a u8 tag, a u32
/// little-endian payload length, the payload. Text and bytes of any length.
///   sdm_piv::SqlValues p; p.i64(25544).str("ISS (ZARYA)").bytes(key, 32);
///   sdm_piv::call("storage.flatsql_query_stream", "SqlStreamParams", s, {sdm_piv::raw("sql", sql), p.frame()});
enum SqlTag : uint8_t { kSqlNull = 0, kSqlBool = 1, kSqlI64 = 2, kSqlF64 = 3, kSqlStr = 4, kSqlBytes = 5 };
class SqlValues {
 public:
  SqlValues& null() { return put(kSqlNull, nullptr, 0); }
  SqlValues& boolean(bool v) { const uint8_t b = v ? 1 : 0; return put(kSqlBool, &b, 1); }
  SqlValues& i64(int64_t v) { uint8_t b[8]; for (int i = 0; i < 8; ++i) b[i] = static_cast<uint8_t>(static_cast<uint64_t>(v) >> (8 * i)); return put(kSqlI64, b, 8); }
  SqlValues& f64(double v) { uint64_t u; std::memcpy(&u, &v, 8); return i64_bits(kSqlF64, u); }
  SqlValues& str(std::string_view v) { return put(kSqlStr, reinterpret_cast<const uint8_t*>(v.data()), v.size()); }
  SqlValues& bytes(const uint8_t* data, size_t size) { return put(kSqlBytes, data, size); }
  std::string_view view() const { return bytes_; }
  /// The raw frame (default port "params"); the values must outlive the call.
  Frame frame(const char* port = "params") const { return raw(port, bytes_); }

 private:
  SqlValues& i64_bits(uint8_t tag, uint64_t u) { uint8_t b[8]; for (int i = 0; i < 8; ++i) b[i] = static_cast<uint8_t>(u >> (8 * i)); return put(tag, b, 8); }
  SqlValues& put(uint8_t tag, const uint8_t* data, size_t size) {
    bytes_.push_back(static_cast<char>(tag));
    for (int i = 0; i < 4; ++i) bytes_.push_back(static_cast<char>((static_cast<uint32_t>(size) >> (8 * i)) & 0xff));
    if (size) bytes_.append(reinterpret_cast<const char*>(data), size);
    return *this;
  }
  std::string bytes_;
};
/// One decoded SQL value: its tag and payload (in place).
struct SqlValue {
  uint8_t tag;
  std::string_view payload;
  bool as_bool() const { return !payload.empty() && payload[0] != 0; }
  int64_t as_i64() const { uint64_t u = 0; for (size_t i = 0; i < 8 && i < payload.size(); ++i) u |= static_cast<uint64_t>(static_cast<uint8_t>(payload[i])) << (8 * i); return static_cast<int64_t>(u); }
  double as_f64() const { const uint64_t u = static_cast<uint64_t>(as_i64()); double d; std::memcpy(&d, &u, 8); return d; }
};
/// The values of a tagged SQL value run; false when it is malformed.
inline bool read_sql_values(std::string_view bytes, std::vector<SqlValue>& out) {
  out.clear();
  size_t at = 0;
  while (at < bytes.size()) {
    if (bytes.size() - at < 5) return false;
    uint32_t size = 0;
    for (int i = 0; i < 4; ++i) size |= static_cast<uint32_t>(static_cast<uint8_t>(bytes[at + 1 + i])) << (8 * i);
    if (bytes.size() - at - 5 < size) return false;
    out.push_back({static_cast<uint8_t>(bytes[at]), bytes.substr(at + 5, size)});
    at += 5 + size;
  }
  return true;
}

}  // namespace sdm_piv

#endif  // SDM_PIV_HOSTCALL_HPP
