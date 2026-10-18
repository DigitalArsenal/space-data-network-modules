// IVOA TAP synchronous queries (ADQL, CSV answers) through the node's
// http.request host call, and the CSV they answer with.
#pragma once
#include <cmath>
#include <cstdlib>
#include <string>
#include <string_view>
#include <vector>

namespace gaia_octree::tap {

inline std::string urlencode(std::string_view s) {
  static const char* hex = "0123456789ABCDEF";
  std::string out;
  for (const unsigned char c : s) {
    if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.' || c == '~') out += char(c);
    else { out += '%'; out += hex[c >> 4]; out += hex[c & 15]; }
  }
  return out;
}

struct Answer {
  int status = 0;
  std::vector<uint8_t> body;
  std::string error;
};

// One POST to <service>/sync; the caller checks what came back.
inline Answer post(const std::string& service, const std::string& adql, uint32_t timeoutMs, uint64_t maxBytes) {
  Answer a;
  namespace R = sdn::runtime;
  R::Aligned::HttpParams params{};
  sdm_piv::put(params.METHOD, "POST");
  params.set_has_METHOD(true);
  params.TIMEOUT_MS = timeoutMs;
  params.MAX_BYTES = maxBytes;
  const std::string url = service + "/sync";
  // MAXREC: without it ESA's sync service stops at 50,000 rows and says nothing in CSV.
  const std::string body = "REQUEST=doQuery&LANG=ADQL&FORMAT=csv&MAXREC=3000000&QUERY=" + urlencode(adql);
  const std::string headers = "Content-Type: application/x-www-form-urlencoded\r\n";
  const std::vector<sdm_piv::Frame> frames{
      {"params", reinterpret_cast<const uint8_t*>(&params), sizeof(params), "HttpParams", uint32_t(sizeof(params)),
       uint16_t(alignof(R::Aligned::HttpParams))},
      sdm_piv::raw("url", url), sdm_piv::raw("headers", headers), sdm_piv::raw("body", body)};
  const auto response = sdm_piv::call_frames("http.request", frames);
  if (!response.ok()) { a.error = response.error_message(); return a; }
  const auto* result = response.result<R::Aligned::HttpResult>();
  if (!result) { a.error = "no HttpResult"; return a; }
  a.status = result->STATUS;
  const auto bytes = response.raw("body");
  a.body.assign(bytes.begin(), bytes.end());
  return a;
}

// A query answered with CSV whose header line starts with `header`; an
// error page, a VOTable error document, 408, 429 and 5xx are retried.
inline Answer query(const std::string& service, const std::string& adql, const std::string& header, std::string& why, int attempts = 4) {
  Answer a;
  for (int i = 0; i < attempts; ++i) {
    a = post(service, adql, 300000, 100ull * 1024 * 1024);
    const bool csv = a.status == 200 && a.body.size() >= header.size() && std::string_view(reinterpret_cast<const char*>(a.body.data()), header.size()) == header;
    if (csv) return a;
    const bool retry = a.status == 0 || a.status == 200 || a.status == 408 || a.status == 429 || a.status >= 500;
    why = service + " answered " + std::to_string(a.status) + " (" + std::to_string(a.body.size()) + " B" + (a.error.empty() ? "" : ", " + a.error) + ") to: " + adql.substr(0, 160);
    if (!retry) break;
  }
  a.body.clear();
  return a;
}

// CSV rows of a TAP answer: header names, then fields per row as views into
// the body (no field of these tables holds a comma; quotes are stripped).
class Csv {
 public:
  explicit Csv(const std::vector<uint8_t>& body) : text_(reinterpret_cast<const char*>(body.data()), body.size()) {
    std::vector<std::string_view> head;
    next(head);
    for (const auto h : head) names_.emplace_back(h);
  }
  int column(std::string_view name) const {
    for (size_t i = 0; i < names_.size(); ++i) if (names_[i] == name) return int(i);
    return -1;
  }
  size_t width() const { return names_.size(); }
  // The next row's fields; false at the end.
  bool next(std::vector<std::string_view>& fields) {
    fields.clear();
    while (at_ < text_.size() && (text_[at_] == '\n' || text_[at_] == '\r')) ++at_;
    if (at_ >= text_.size()) return false;
    size_t end = text_.find('\n', at_);
    if (end == std::string_view::npos) end = text_.size();
    std::string_view line = text_.substr(at_, end - at_);
    at_ = end + 1;
    if (!line.empty() && line.back() == '\r') line.remove_suffix(1);
    size_t from = 0;
    for (;;) {
      const size_t comma = line.find(',', from);
      std::string_view f = line.substr(from, comma == std::string_view::npos ? std::string_view::npos : comma - from);
      if (f.size() >= 2 && f.front() == '"' && f.back() == '"') f = f.substr(1, f.size() - 2);
      fields.push_back(f);
      if (comma == std::string_view::npos) break;
      from = comma + 1;
    }
    return true;
  }

 private:
  std::string_view text_;
  size_t at_ = 0;
  std::vector<std::string> names_;
};

inline double number(std::string_view f) {
  if (f.empty() || f.size() > 62 || f == "null" || f == "NaN") return NAN;
  char s[64];
  f.copy(s, f.size());
  s[f.size()] = '\0';
  char* end = nullptr;
  const double v = std::strtod(s, &end);
  return end && *end == '\0' ? v : NAN;
}
inline uint64_t integer(std::string_view f) {
  uint64_t v = 0;
  for (const char c : f) { if (c < '0' || c > '9') return 0; v = v * 10 + uint64_t(c - '0'); }
  return v;
}

}  // namespace gaia_octree::tap
