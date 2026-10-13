#include "space_data_module_invoke.h"
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

// The astorb.dat core shared by the portable module (lowell_astorb.cpp:
// plan_astorb, parse_astorb) and its host adapter (host-adapter/src/adapter.cpp:
// ingest_astorb, which streams the same records into the node's store in
// parts). One copy of the fixed-column rules and the $OMM layout.
#ifndef LOWELL_ASTORB_CORE_HPP
#define LOWELL_ASTORB_CORE_HPP
using Json = nlohmann::json;
namespace astorb {
// Internal linkage: the portable module and its host adapter are linked into
// one flow runtime, each with its own copy of this core.
namespace {
constexpr size_t maxControlBytes = 1 << 20;
constexpr size_t rangeBytes = 48u * 1024u * 1024u;         // under the Go host's 100 MB response ceiling
constexpr int rangeCount = 3;                               // 144 MiB of headroom over a 112 MB file
constexpr size_t maxGzipBytes = rangeBytes * rangeCount;
constexpr size_t maxTextBytes = 512u * 1024u * 1024u;       // astorb.dat is about 240 MB
constexpr const char* sourceUrl = "https://ftp.lowell.edu/pub/elgb/astorb.dat.gz";
constexpr const char* providerId = "lowell-astorb";
constexpr const char* sourceName = "astorb-numbered";
constexpr double auKm = 149597870.7;                        // IAU 2012 B2
constexpr double gmSunKm3s2 = 1.3271244004127942e11;       // gm_de440.tpc BODY10_GM
constexpr int32_t sunNaifId = 10;
constexpr const char* credit =
    "Asteroid orbits: astorb.dat, Dr. Edward Bowell, Lowell Observatory (NASA grant NAG5-4741 and the Lowell "
    "Observatory endowment)";
constexpr const char* licence =
    "astorb.dat may be freely used, copied, and transmitted provided attribution to Dr. Edward Bowell and the "
    "funding sources (NASA grant NAG5-4741, the Lowell Observatory endowment) is made.";

const char* error = "Invalid astorb input.";
int fail(const char* message) { plugin_set_error("invalid-lowell-astorb-input", message); return 1; }
#define CHECK(condition, message) do { if (!(condition)) return fail(message); } while (0)

const plugin_input_frame_t* frame(const char* port, size_t limit) {
  const plugin_input_frame_t* found = nullptr;
  for (uint32_t i = 0; i < plugin_get_input_count(); ++i) {
    const auto* f = plugin_get_input_frame(i);
    if (!f || !f->port_id || !f->payload) return nullptr;
    if (std::strcmp(f->port_id, port) == 0) {
      if (found || f->payload_length == 0 || f->payload_length > limit) return nullptr;
      found = f;
    }
  }
  return found;
}
Json json(const char* port) {
  const auto* f = frame(port, maxControlBytes);
  return f ? Json::parse(f->payload, f->payload + f->payload_length, nullptr, false) : Json();
}
int output(const char* port, const Json& value) {
  const auto text = value.dump();
  return plugin_push_output_ex(port, nullptr, nullptr, PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY, nullptr, 0, 1,
                               reinterpret_cast<const uint8_t*>(text.data()), text.size());
}
std::string text(const Json& o, const char* key) {
  return o.is_object() && o.contains(key) && o[key].is_string() ? o[key].get<std::string>() : std::string();
}

// ── fixed columns (astorb.html), with the provider's exact parsing rules ──
bool numberField(const char* line, size_t a, size_t b, double& value) {
  size_t s = a, e = b;
  while (s < e && (line[s] == ' ' || line[s] == '\t')) ++s;
  while (e > s && (line[e - 1] == ' ' || line[e - 1] == '\t' || line[e - 1] == '\r')) --e;
  if (s == e) return false;
  std::string t(line + s, e - s);
  char* end = nullptr;
  value = std::strtod(t.c_str(), &end);
  return end == t.c_str() + t.size() && std::isfinite(value);
}

struct Row {
  int64_t number;
  std::string name;  // UTF-8
  bool hasH, hasG, hasD;
  double h, g, d;
  std::string epoch;
  double m, w, node, inc, e, aAu;
};

std::string latin1ToUtf8(const char* p, size_t n) {
  std::string s;
  s.reserve(n);
  for (size_t i = 0; i < n; ++i) {
    const uint8_t c = uint8_t(p[i]);
    if (c < 0x80) s.push_back(char(c));
    else { s.push_back(char(0xc0 | (c >> 6))); s.push_back(char(0x80 | (c & 0x3f))); }
  }
  return s;
}

bool parseLine(const char* line, size_t len, Row& row) {
  if (len < 182) return false;
  double num;
  if (!numberField(line, 0, 6, num) || num != std::floor(num)) return false;
  size_t es = 106, ee = 114;
  while (es < ee && line[es] == ' ') ++es;
  while (ee > es && line[ee - 1] == ' ') --ee;
  if (ee - es != 8) return false;
  for (size_t i = es; i < ee; ++i) if (line[i] < '0' || line[i] > '9') return false;
  row.number = int64_t(num);
  size_t ns = 7, ne = 25;
  while (ns < ne && line[ns] == ' ') ++ns;
  while (ne > ns && line[ne - 1] == ' ') --ne;
  row.name = latin1ToUtf8(line + ns, ne - ns);
  row.hasH = numberField(line, 42, 47, row.h);
  row.hasG = numberField(line, 48, 53, row.g);
  row.hasD = numberField(line, 59, 64, row.d);
  const char* ep = line + es;
  row.epoch = std::string(ep, 4) + "-" + std::string(ep + 4, 2) + "-" + std::string(ep + 6, 2) + "T00:00:00";
  return numberField(line, 115, 125, row.m) && numberField(line, 126, 136, row.w) &&
         numberField(line, 137, 147, row.node) && numberField(line, 148, 157, row.inc) &&
         numberField(line, 158, 168, row.e) && numberField(line, 169, 182, row.aAu);
}

// ECMAScript Number::toString for the values astorb carries: the shortest
// decimal that round-trips, written without an exponent in [1e-7, 1e21).
std::string jsNumber(double v) {
  if (v == 0) return "0";
  char buffer[64];
  for (int precision = 1; precision <= 17; ++precision) {
    std::snprintf(buffer, sizeof buffer, "%.*e", precision - 1, v);
    if (std::strtod(buffer, nullptr) == v) break;
  }
  // buffer: [-]d[.ddd]e[+-]XX -> plain decimal
  std::string s(buffer);
  const bool negative = s[0] == '-';
  if (negative) s.erase(0, 1);
  const size_t ePos = s.find('e');
  const int exponent = std::atoi(s.c_str() + ePos + 1);
  std::string digits;
  for (size_t i = 0; i < ePos; ++i) if (s[i] != '.') digits.push_back(s[i]);
  while (digits.size() > 1 && digits.back() == '0') digits.pop_back();
  std::string out;
  if (exponent >= 21 || exponent < -7) {
    out = digits.substr(0, 1);
    if (digits.size() > 1) out += "." + digits.substr(1);
    out += std::string("e") + (exponent >= 0 ? "+" : "-") + std::to_string(std::abs(exponent));
  } else if (exponent >= 0) {
    if (int(digits.size()) <= exponent + 1) out = digits + std::string(exponent + 1 - digits.size(), '0');
    else out = digits.substr(0, exponent + 1) + "." + digits.substr(exponent + 1);
  } else {
    out = "0." + std::string(-exponent - 1, '0') + digits;
  }
  return negative ? "-" + out : out;
}

int band(const Row& r) {
  const double h = r.hasH ? r.h : 99;
  return h < 12 ? 0 : h < 15 ? 1 : h < 17 ? 2 : 3;
}

void buildRecord(const Row& r, flatbuffers::FlatBufferBuilder& b) {
  b.Clear();
  std::vector<flatbuffers::Offset<OMMUserDefinedParameter>> params;
  const auto param = [&](const char* name, bool has, double value) {
    if (!has) return;
    const auto n = b.CreateString(name);
    const auto v = b.CreateString(jsNumber(value));
    params.push_back(CreateOMMUserDefinedParameter(b, n, v));
  };
  param("H", r.hasH, r.h);
  param("G", r.hasG, r.g);
  param("DIAMETER_KM", r.hasD, r.d);
  const auto paramsVector = params.empty() ? 0 : b.CreateVector(params);
  RFMOriginBuilder origin(b);
  origin.add_KIND(rfmOriginKind::CELESTIAL_BODY);
  origin.add_CELESTIAL_BODY_ID(sunNaifId);
  const auto originOffset = origin.Finish();
  RFMCoordinateSystemBuilder system(b);
  system.add_AXIS_TYPE(rfmAxisType::MEAN_ECLIPTIC_EQUINOX_J2000);
  system.add_ORIGIN(originOffset);
  const auto systemOffset = system.Finish();
  const auto wrapper = CreateRFMCoordinateSystemWrapper(b, systemOffset);
  RFMBuilder frame(b);
  frame.add_REFERENCE_FRAME_type(RFMUnion::RFMCoordinateSystemWrapper);
  frame.add_REFERENCE_FRAME(wrapper.Union());
  const auto frameOffset = frame.Finish();
  const auto name = r.name.empty() ? 0 : b.CreateString(r.name);
  const auto id = b.CreateString(std::to_string(r.number));
  const auto center = b.CreateString("SUN");
  const auto epoch = b.CreateString(r.epoch);
  OMMBuilder omm(b);
  if (!r.name.empty()) omm.add_OBJECT_NAME(name);
  omm.add_OBJECT_ID(id);
  omm.add_CENTER_NAME(center);
  omm.add_REFERENCE_FRAME(frameOffset);
  omm.add_TIME_SYSTEM(timingStandard::TT);
  omm.add_EPOCH(epoch);
  omm.add_SEMI_MAJOR_AXIS(r.aAu * auKm);
  omm.add_ECCENTRICITY(r.e);
  omm.add_INCLINATION(r.inc);
  omm.add_RA_OF_ASC_NODE(r.node);
  omm.add_ARG_OF_PERICENTER(r.w);
  omm.add_MEAN_ANOMALY(r.m);
  omm.add_GM(gmSunKm3s2);
  if (!params.empty()) omm.add_USER_DEFINED_PARAMETERS(paramsVector);
  FinishSizePrefixedOMMBuffer(b, omm.Finish());
}

Json canonicalJob() {
  return {{"source_url", sourceUrl}, {"provider_id", providerId}, {"source_name", sourceName}};
}

// ── gzip (RFC 1952) streamed over miniz's raw inflate ──────────────────────
// The download arrives as up to three byte ranges. They are never joined into
// one buffer and the 240 MB of text is never held: the deflate stream is
// inflated through a 32 KiB window, line by line, across the ranges, and the
// CRC-32 and length in the gzip trailer are checked at the end. (The whole-
// buffer join and inflate held ~0.5 GB in the module and the node; host-01 has
// 7 GB for everything, coordinator D3.)
struct Span { const uint8_t* data; size_t size; };
struct GzipInput {
  std::vector<Span> spans;
  size_t size = 0;
  uint8_t at(size_t offset) const {
    for (const auto& s : spans) { if (offset < s.size) return s.data[offset]; offset -= s.size; }
    return 0;
  }
};
uint32_t le32(const uint8_t* p) { return uint32_t(p[0]) | uint32_t(p[1]) << 8 | uint32_t(p[2]) << 16 | uint32_t(p[3]) << 24; }

// Inflate the member and call onLine(line, length) for every line (without
// the newline). False, with `error` set, on a malformed member or a CRC or
// length mismatch; lines seen before the trailer check are the caller's to
// discard (callers validate in one pass and act in the next).
template <class OnLine>
bool forEachLine(const GzipInput& gz, OnLine onLine) {
  const size_t n = gz.size;
  if (n < 18 || gz.at(0) != 0x1f || gz.at(1) != 0x8b || gz.at(2) != 8) { error = "Response is not gzip (RFC 1952, deflate)."; return false; }
  const uint8_t flags = gz.at(3);
  if (flags & 0xe0) { error = "gzip header has reserved flags set."; return false; }
  size_t at = 10;
  if (flags & 4) { if (at + 2 > n) return false; at += 2 + (size_t(gz.at(at)) | size_t(gz.at(at + 1)) << 8); }
  if (flags & 8) { while (at < n && gz.at(at)) ++at; ++at; }
  if (flags & 16) { while (at < n && gz.at(at)) ++at; ++at; }
  if (flags & 2) at += 2;
  if (at + 8 > n) { error = "gzip member is truncated."; return false; }
  uint8_t trailer[8];
  for (int i = 0; i < 8; ++i) trailer[i] = gz.at(n - 8 + i);
  const uint32_t crcWant = le32(trailer), sizeWant = le32(trailer + 4);
  // ISIZE is the length modulo 2^32; astorb.dat is far below that.
  if (sizeWant == 0 || sizeWant > maxTextBytes) { error = "Inflated astorb.dat size is outside its budget."; return false; }
  const size_t deflateEnd = n - 8;
  std::vector<uint8_t> window(TINFL_LZ_DICT_SIZE);
  tinfl_decompressor inflator;
  tinfl_init(&inflator);
  size_t windowPos = 0, produced = 0, consumedTotal = at;
  mz_ulong crc = MZ_CRC32_INIT;
  std::string carry;
  size_t spanIndex = 0, spanOffset = at;
  while (spanIndex < gz.spans.size() && spanOffset >= gz.spans[spanIndex].size) { spanOffset -= gz.spans[spanIndex].size; ++spanIndex; }
  const auto emit = [&](const uint8_t* p, size_t len) {
    crc = mz_crc32(crc, p, len);
    produced += len;
    size_t start = 0;
    for (size_t i = 0; i < len; ++i) {
      if (p[i] != '\n') continue;
      if (carry.empty()) onLine(reinterpret_cast<const char*>(p + start), i - start);
      else { carry.append(reinterpret_cast<const char*>(p + start), i - start); onLine(carry.data(), carry.size()); carry.clear(); }
      start = i + 1;
    }
    if (start < len) carry.append(reinterpret_cast<const char*>(p + start), len - start);
  };
  for (;;) {
    const uint8_t* in = nullptr;
    size_t inSize = 0;
    if (spanIndex < gz.spans.size()) {
      const Span& s = gz.spans[spanIndex];
      in = s.data + spanOffset;
      inSize = s.size - spanOffset;
      if (consumedTotal + inSize > deflateEnd) inSize = deflateEnd - consumedTotal;
    }
    const bool more = consumedTotal + inSize < deflateEnd;
    size_t outSize = window.size() - windowPos;
    const tinfl_status status = tinfl_decompress(&inflator, in, &inSize, window.data(), window.data() + windowPos, &outSize,
                                                 more ? TINFL_FLAG_HAS_MORE_INPUT : 0);
    consumedTotal += inSize;
    spanOffset += inSize;
    while (spanIndex < gz.spans.size() && spanOffset >= gz.spans[spanIndex].size) { spanOffset -= gz.spans[spanIndex].size; ++spanIndex; }
    if (outSize) emit(window.data() + windowPos, outSize);
    windowPos = (windowPos + outSize) & (window.size() - 1);
    if (produced > maxTextBytes) { error = "Inflated astorb.dat size is outside its budget."; return false; }
    if (status == TINFL_STATUS_DONE) break;
    if (status < 0) { error = "gzip stream did not inflate."; return false; }
    if (status == TINFL_STATUS_NEEDS_MORE_INPUT && !more) { error = "gzip member is truncated."; return false; }
  }
  if (!carry.empty()) { onLine(carry.data(), carry.size()); carry.clear(); }
  if (produced != sizeWant) { error = "gzip stream did not inflate to its stated length."; return false; }
  if (uint32_t(crc) != crcWant) { error = "gzip CRC-32 does not match the inflated astorb.dat."; return false; }
  return true;
}

// The job, receipt and three range responses of one retrieval, checked the
// way parse_astorb always checked them, as spans over the frames (no copy).
// Returns the producer peer and retrieval time through the out arguments.
const char* readRetrieval(GzipInput& gz, std::string& peer, int64_t& retrieved) {
  if (plugin_get_input_count() != 2 + rangeCount) return "Exactly one job, receipt and response frame per range are required.";
  const Json job = json("job"), receipt = json("receipt");
  if (job != canonicalJob()) return "Job differs from the canonical astorb plan.";
  if (!(receipt.is_object() && receipt.contains("retrieved_at_ms") && receipt["retrieved_at_ms"].is_number_integer())) return "Invalid retrieval epoch.";
  retrieved = receipt["retrieved_at_ms"].get<int64_t>();
  if (!(retrieved > 0 && retrieved <= 9007199254740991LL)) return "Invalid retrieval epoch.";
  peer = text(receipt, "producer_peer_id");
  if (peer.empty() || peer.size() > 128) return "An authenticated producer peer ID is required.";
  // Every range but the last present one must be full; a 416 ends the file.
  // A server that ignores Range answers 200 with the whole file on the first
  // request, which is accepted only alone.
  bool ended = false;
  for (int i = 0; i < rangeCount; ++i) {
    const std::string port = "response" + std::to_string(i);
    const auto* response = frame(port.c_str(), rangeBytes + 8);
    if (!(response && response->payload_length >= 8 && std::memcmp(response->payload, "$HRB", 4) == 0)) return "Expected one raw-body-v1 HTTP response per range.";
    const uint32_t status = le32(response->payload + 4);
    const size_t length = response->payload_length - 8;
    if (status == 304 && i == 0) return "astorb.dat is unchanged; the host adapter ends an unchanged cycle before parsing.";
    if (status == 304) return "astorb.dat changed between ranges; refusing a mixed join (the next cycle retries).";
    if (ended || status == 416) {
      if (status != 416) return "A range after the end of astorb.dat answered with data; the file changed mid-retrieval.";
      ended = true;
      continue;
    }
    if (!(status == 206 || (status == 200 && i == 0))) return "astorb.dat request did not succeed; the published catalog stays.";
    gz.spans.push_back({response->payload + 8, length});
    gz.size += length;
    if (status == 200 || length < rangeBytes) ended = true;
  }
  if (!ended) return "astorb.dat is larger than the planned ranges; refusing a truncated catalog.";
  return nullptr;
}

std::string sourceSha256(const GzipInput& gz) {
  ephem::Sha256 sha;
  for (const auto& s : gz.spans) sha.update(s.data, s.size);
  return sha.hex();
}

// The validation pass: every line parsed and counted, the gzip trailer
// checked. Nothing is kept but the counts.
struct Survey {
  size_t rows = 0, lines = 0, skipped = 0;
  size_t bands[4] = {0, 0, 0, 0};
  std::string minEpoch, maxEpoch;
};
bool survey(const GzipInput& gz, Survey& out) {
  Row row;
  return forEachLine(gz, [&](const char* line, size_t len) {
    if (len == 0) return;
    ++out.lines;
    if (!parseLine(line, len, row)) { ++out.skipped; return; }
    if (out.minEpoch.empty() || row.epoch < out.minEpoch) out.minEpoch = row.epoch;
    if (out.maxEpoch.empty() || row.epoch > out.maxEpoch) out.maxEpoch = row.epoch;
    ++out.rows;
    ++out.bands[band(row)];
  });
}

Json ingestMeta(const std::string& sourceSha, const std::string& peer) {
  return {{"schema", "OMM.fbs"}, {"batch_id", sourceSha}, {"provider_id", providerId},
          {"source_name", sourceName}, {"source_url", sourceUrl}, {"source_peer", peer},
          {"reconcile", "current"}, {"origin_id", "lowell.edu"}, {"origin_name", "Lowell Observatory astorb"},
          {"dataset_id", "lowell-astorb/numbered"}, {"terms_url", "https://asteroid.lowell.edu/astorb/"},
          {"citation", credit}, {"licence", licence}};
}

Json surveyReport(const Survey& s, const std::string& sourceSha, size_t gzLength, size_t recordBytes, int64_t retrieved) {
  return {{"records", s.rows}, {"lines", s.lines}, {"skipped_lines", s.skipped},
          {"bands", {{"H00-12", s.bands[0]}, {"H12-15", s.bands[1]}, {"H15-17", s.bands[2]}, {"H17-99", s.bands[3]}}},
          {"epoch_min", s.minEpoch}, {"epoch_max", s.maxEpoch}, {"source_sha256", sourceSha},
          {"gzip_bytes", gzLength}, {"record_bytes", recordBytes}, {"retrieved_at_ms", retrieved}};
}

// Every record of one H band, in file (number) order: the bands in turn give
// the brightest-first order parse_astorb has always emitted.
template <class OnRecord>
bool forEachRecordInBand(const GzipInput& gz, int wanted, flatbuffers::FlatBufferBuilder& b, OnRecord onRecord) {
  Row row;
  return forEachLine(gz, [&](const char* line, size_t len) {
    if (len == 0 || !parseLine(line, len, row) || band(row) != wanted) return;
    buildRecord(row, b);
    onRecord(b.GetBufferPointer(), b.GetSize());
  });
}
// config (from the host adapter) -> request0..2 + job (plan_astorb, exported
// by both the portable module and the host adapter).
int planAstorb() {
  const Json config = json("config");
  CHECK(config.is_object(), "Exactly one configuration object is required.");
  CHECK(!config.contains("url") || text(config, "url") == sourceUrl, "Only the canonical Lowell astorb.dat.gz is accepted.");
  for (int i = 0; i < rangeCount; ++i) {
    const std::string range = "bytes=" + std::to_string(size_t(i) * rangeBytes) + "-" + std::to_string(size_t(i + 1) * rangeBytes - 1);
    // Each range has its own URL (a query the static server ignores), and
    // each request states its own validator. The host otherwise presents the
    // last 2xx's ETag for a URL as If-None-Match, which breaks a ranged join
    // twice over: on one URL range 1 answers 304 to range 0's ETag, and the
    // host books a validator on any 2xx, so a cycle that fetched but did not
    // land (a refused parse, a restart) would answer 304 until Lowell's next
    // daily update and keep the catalog stale. astorb.dat changes daily, so
    // there is no unchanged cycle to save; the request always asks for bytes.
    const std::string url = std::string(sourceUrl) + "?sdn-range=" + std::to_string(i);
    const Json request = {{"method", "GET"}, {"url", url},
                          {"headers", {{"Range", range}, {"If-Modified-Since", "Thu, 01 Jan 1970 00:00:00 GMT"}}}, {"timeoutMs", 600000},
                          {"maxBytes", rangeBytes}, {"responseWire", "raw-body-v1"}};
    const std::string port = "request" + std::to_string(i);
    if (output(port.c_str(), request) < 0) return 1;
  }
  return output("job", canonicalJob()) < 0 ? 1 : 0;
}
}  // namespace
}  // namespace astorb
#endif  // LOWELL_ASTORB_CORE_HPP
