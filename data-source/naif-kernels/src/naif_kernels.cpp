#include "space_data_module_invoke.h"
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <map>
#include <string>
#include <vector>

// Planetary, satellite and small-body ephemerides and orientation for
// propagator/solar-system-bodies, retrieved from NASA/JPL NAIF and SSD and cut
// into decade shards: the WASM form of that module's tools/build_kernels.py.
//
// The source kernels are hundreds of megabytes to a gigabyte each (jup365.bsp
// is 1.1 GB), and a shard needs a few megabytes of each, so nothing is
// downloaded whole. Every stage asks for byte ranges the previous one proved
// are needed:
//   plan_kernels  the DAF file record of each binary kernel;
//   advance (1)   the first and last summary records;
//   advance (2)   any middle summary record, and the type-2 directory (INIT,
//                 INTLEN, RSIZE, N) of every segment a shard needs;
//   advance (3)   directories found in middle records, and the text kernels;
//   advance (4)   one window of Chebyshev records per needed segment, the
//                 union of its decades;
//   build_kernels copies each decade's records into a new DAF, unchanged (no
//                 refit; CSPICE spksub/pckw02 semantics), and emits one file
//                 frame per shard and text kernel.
// Fetching, IPFS and storage belong to the host: the host adapter adds the
// files to the node's IPFS and announce_kernels emits one $PNM per file
// (FILE_NAME, CID), which the node's auto-publisher announces under provider
// naif, source ssb-kernels.
//
// Every range has its own URL (a query the static servers ignore) and states
// its own validator, so the host's per-URL If-None-Match never applies: ranges
// of one file must not answer 304 to each other's ETag, and the host books a
// validator on any 2xx, so a cycle that fetched but did not land would
// otherwise answer 304 forever for kernels that rarely change. The weekly
// cycle costs about 160 MB of ranges. A 304 on every file record (a server
// that ignores the validator) still ends the cycle as unchanged.
//
// Licence: NASA/JPL NAIF generic kernels and JPL SSD small-body ephemerides
// are produced by NASA's Jet Propulsion Laboratory and distributed freely by
// the NAIF node of the Planetary Data System; the credit rides in the ingest
// meta and so in every publication.

using Json = nlohmann::json;
namespace {
constexpr size_t maxControlBytes = 8u * 1024u * 1024u;
constexpr size_t maxRangeBytes = 48u * 1024u * 1024u;
constexpr size_t maxFrames = 60;  // the flow runtime hands a node at most 64 frames per invocation
constexpr size_t kRecord = 1024;
constexpr const char* providerId = "naif";
constexpr const char* sourceName = "ssb-kernels";
constexpr const char* credit =
    "Ephemerides and orientation: NASA/JPL NAIF (DE440, JPL satellite and small-body ephemerides), IAU WGCCRE 2015";
constexpr const char* licence =
    "NASA/JPL NAIF generic kernels: produced by NASA's Jet Propulsion Laboratory, distributed freely by the NAIF "
    "node of the Planetary Data System";

struct Source { const char* file; const char* url; std::vector<int> bodies; int y0, y1; };
const std::vector<Source>& sources() {
  static const std::vector<Source> s = {
      {"de440s.bsp", "https://naif.jpl.nasa.gov/pub/naif/generic_kernels/spk/planets/de440s.bsp",
       {1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 199, 299, 301, 399}, 1950, 2050},
      {"mar099s.bsp", "https://naif.jpl.nasa.gov/pub/naif/generic_kernels/spk/satellites/mar099s.bsp", {401, 402, 499}, 2000, 2050},
      {"jup365.bsp", "https://naif.jpl.nasa.gov/pub/naif/generic_kernels/spk/satellites/jup365.bsp", {501, 502, 503, 504, 599}, 2000, 2050},
      {"sat441.bsp", "https://naif.jpl.nasa.gov/pub/naif/generic_kernels/spk/satellites/sat441.bsp",
       {601, 602, 603, 604, 605, 606, 608, 699}, 2000, 2050},
      {"ura184_part-3.bsp", "https://naif.jpl.nasa.gov/pub/naif/generic_kernels/spk/satellites/ura184_part-3.bsp",
       {701, 702, 703, 704, 705, 799}, 2000, 2050},
      {"nep097.bsp", "https://naif.jpl.nasa.gov/pub/naif/generic_kernels/spk/satellites/nep097.bsp", {801, 899}, 2000, 2050},
      {"plu060.bsp", "https://naif.jpl.nasa.gov/pub/naif/generic_kernels/spk/satellites/plu060.bsp", {901, 999}, 2000, 2050},
      {"sb441-n16.bsp", "https://ssd.jpl.nasa.gov/ftp/eph/small_bodies/asteroids_de441/sb441-n16.bsp", {2000001, 2000004}, 2000, 2050},
  };
  return s;
}
constexpr const char* lunarFile = "moon_pa_de440_200625.bpc";
constexpr const char* lunarUrl = "https://naif.jpl.nasa.gov/pub/naif/generic_kernels/pck/moon_pa_de440_200625.bpc";
const std::vector<std::pair<const char*, const char*>>& texts() {
  static const std::vector<std::pair<const char*, const char*>> t = {
      {"pck00011.tpc", "https://naif.jpl.nasa.gov/pub/naif/generic_kernels/pck/pck00011.tpc"},
      {"gm_de440.tpc", "https://naif.jpl.nasa.gov/pub/naif/generic_kernels/pck/gm_de440.tpc"},
      {"moon_de440_250416.tf", "https://naif.jpl.nasa.gov/pub/naif/generic_kernels/fk/satellites/moon_de440_250416.tf"},
  };
  return t;
}
// One core shard per decade (planets, Sun, Moon, planet centres, Ceres,
// Vesta) and one per satellite system, the order build_kernels.py writes.
const std::vector<std::pair<const char*, std::vector<int>>>& shards() {
  static const std::vector<std::pair<const char*, std::vector<int>>> s = {
      {"core", {1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 199, 299, 301, 399, 499, 599, 699, 799, 899, 999, 2000001, 2000004}},
      {"mars", {401, 402}},
      {"jupiter", {501, 502, 503, 504}},
      {"saturn", {601, 602, 603, 604, 605, 606, 608}},
      {"uranus", {701, 702, 703, 704, 705}},
      {"neptune", {801}},
      {"pluto", {901}},
  };
  return s;
}
constexpr int firstDecade = 1950, lastDecade = 2040;

const char* error = "Invalid NAIF kernel input.";
int fail(const char* message) { plugin_set_error("invalid-naif-kernels-input", message); return 1; }
#define CHECK(condition, message) do { if (!(condition)) return fail(message); } while (0)
#define NEED(condition, message) do { if (!(condition)) { error = message; return false; } } while (0)

// TDB seconds past J2000 at YYYY-01-01T00:00:00 TDB (build_kernels.py et_of_year).
double etOfYear(int year) {
  const int y = year - 1, m = 13;
  const int a = y / 100;
  const double jd = std::floor(365.25 * (y + 4716)) + std::floor(30.6001 * (m + 1)) + 1 + 2 - a + a / 4 - 1524.5;
  return (jd - 2451545.0) * 86400.0;
}

// ── frames ─────────────────────────────────────────────────────────────────
std::vector<const plugin_input_frame_t*> frames(const char* port) {
  std::vector<const plugin_input_frame_t*> out;
  for (uint32_t i = 0; i < plugin_get_input_count(); ++i) {
    const auto* f = plugin_get_input_frame(i);
    if (f && f->port_id && std::strcmp(f->port_id, port) == 0) out.push_back(f);
  }
  return out;
}
Json json(const char* port) {
  const auto list = frames(port);
  if (list.size() != 1 || !list[0]->payload || list[0]->payload_length == 0 || list[0]->payload_length > maxControlBytes) return Json();
  return Json::parse(list[0]->payload, list[0]->payload + list[0]->payload_length, nullptr, false);
}
int output(const char* port, const Json& value) {
  const auto text = value.dump();
  return plugin_push_output_ex(port, nullptr, nullptr, PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY, nullptr, 0, 1,
                               reinterpret_cast<const uint8_t*>(text.data()), text.size());
}
uint32_t le32(const uint8_t* p) { return uint32_t(p[0]) | uint32_t(p[1]) << 8 | uint32_t(p[2]) << 16 | uint32_t(p[3]) << 24; }
int32_t i32(const uint8_t* p) { int32_t v; std::memcpy(&v, p, 4); return v; }
double f64(const uint8_t* p) { double v; std::memcpy(&v, p, 8); return v; }
void putI32(std::vector<uint8_t>& b, size_t at, int32_t v) { std::memcpy(b.data() + at, &v, 4); }
void putF64(std::vector<uint8_t>& b, size_t at, double v) { std::memcpy(b.data() + at, &v, 8); }

std::string b64(const uint8_t* p, size_t n) {
  static const char* t = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::string s;
  s.reserve((n + 2) / 3 * 4);
  size_t i = 0;
  for (; i + 2 < n; i += 3) {
    const uint32_t v = uint32_t(p[i]) << 16 | uint32_t(p[i + 1]) << 8 | p[i + 2];
    s += t[v >> 18]; s += t[(v >> 12) & 63]; s += t[(v >> 6) & 63]; s += t[v & 63];
  }
  if (i + 1 == n) { const uint32_t v = uint32_t(p[i]) << 16; s += t[v >> 18]; s += t[(v >> 12) & 63]; s += "=="; }
  else if (i + 2 == n) { const uint32_t v = uint32_t(p[i]) << 16 | uint32_t(p[i + 1]) << 8; s += t[v >> 18]; s += t[(v >> 12) & 63]; s += t[(v >> 6) & 63]; s += '='; }
  return s;
}
bool unb64(const std::string& s, std::vector<uint8_t>& out) {
  static int8_t d[256];
  static bool init = false;
  if (!init) { std::memset(d, -1, sizeof d); const char* t = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"; for (int i = 0; i < 64; ++i) d[uint8_t(t[i])] = int8_t(i); init = true; }
  out.clear();
  uint32_t acc = 0; int bits = 0;
  for (char c : s) {
    if (c == '=') break;
    const int v = d[uint8_t(c)];
    if (v < 0) return false;
    acc = acc << 6 | uint32_t(v); bits += 6;
    if (bits >= 8) { bits -= 8; out.push_back(uint8_t(acc >> bits)); }
  }
  return true;
}

// The response for request k is responses[k]: the http node emits exactly one
// per request, in order. $HRB + int32 status + body.
struct Response { int status; const uint8_t* body; size_t length; };
bool responses(size_t expected, std::vector<Response>& out) {
  const auto list = frames("response");
  NEED(list.size() == expected, "One HTTP response per planned request is required.");
  out.clear();
  for (const auto* f : list) {
    NEED(f->payload && f->payload_length >= 8 && std::memcmp(f->payload, "$HRB", 4) == 0, "Expected raw-body-v1 HTTP responses.");
    NEED(f->payload_length - 8 <= maxRangeBytes, "An HTTP response is larger than its planned range.");
    out.push_back({int(le32(f->payload + 4)), f->payload + 8, f->payload_length - 8});
  }
  return true;
}

Json rangeRequest(const std::string& url, size_t first, size_t last) {
  const std::string range = std::to_string(first) + "-" + std::to_string(last);
  return {{"method", "GET"}, {"url", url + "?sdn-range=" + range},
          {"headers", {{"Range", "bytes=" + range}, {"If-Modified-Since", "Thu, 01 Jan 1970 00:00:00 GMT"}}},
          {"timeoutMs", 600000}, {"maxBytes", last - first + 1}, {"responseWire", "raw-body-v1"}};
}
Json wholeRequest(const std::string& url) {
  return {{"method", "GET"}, {"url", url}, {"headers", {{"If-Modified-Since", "Thu, 01 Jan 1970 00:00:00 GMT"}}},
          {"timeoutMs", 120000}, {"maxBytes", 4 * 1024 * 1024}, {"responseWire", "raw-body-v1"}};
}

// The binary kernels: the SPKs, then the lunar binary PCK.
struct Kernel { std::string file, url; bool pck; };
std::vector<Kernel> kernels() {
  std::vector<Kernel> k;
  for (const auto& s : sources()) k.push_back({s.file, s.url, false});
  k.push_back({lunarFile, lunarUrl, true});
  return k;
}

bool emit(const std::vector<Json>& requests, const Json& state) {
  NEED(!requests.empty() && requests.size() <= maxFrames, "A stage plans no request or more than the runtime's frame budget.");
  for (const auto& r : requests) NEED(output("request", r) >= 0, "Could not emit a request.");
  NEED(output("state", state) >= 0, "Could not emit the stage state.");
  return true;
}

// ── stage logic ────────────────────────────────────────────────────────────
// Summaries of one summary record. ND=2 always; NI=6 (SPK) or 5 (PCK).
bool readSummaryRecord(const uint8_t* rec, int ni, Json& daf, int recno) {
  const double next = f64(rec), prev = f64(rec + 8), nsum = f64(rec + 16);
  const int ss = 2 + (ni + 1) / 2;
  NEED(nsum >= 0 && nsum <= (128 - 3) / ss && nsum == std::floor(nsum), "Summary record count is out of range.");
  daf["records"][std::to_string(recno)] = {{"next", int(next)}, {"prev", int(prev)}};
  for (int i = 0; i < int(nsum); ++i) {
    const uint8_t* s = rec + 24 + size_t(i) * ss * 8;
    Json ic = Json::array();
    for (int j = 0; j < ni; ++j) ic.push_back(i32(s + 16 + j * 4));
    // Names: ss*8 characters each, at the same index in the name record.
    std::string name(reinterpret_cast<const char*>(rec + kRecord + size_t(i) * ss * 8), size_t(ss) * 8);
    while (!name.empty() && (name.back() == ' ' || name.back() == '\0')) name.pop_back();
    daf["summaries"].push_back({{"record", recno}, {"index", i}, {"dc", {f64(s), f64(s + 8)}}, {"ic", ic}, {"name", name}});
  }
  return true;
}

// Does segment `s` of kernel `k` belong to any shard? Returns the source
// coverage window it is needed for, or false.
bool needed(const Kernel& k, size_t kernelIndex, const Json& s, double& lo, double& hi) {
  const double d0 = s["dc"][0].get<double>(), d1 = s["dc"][1].get<double>();
  if (k.pck) {
    lo = etOfYear(firstDecade); hi = etOfYear(lastDecade + 10);
    return s["ic"][2].get<int>() == 2 && d1 >= lo && d0 <= hi;
  }
  const auto& src = sources()[kernelIndex];
  const int target = s["ic"][0].get<int>();
  if (std::find(src.bodies.begin(), src.bodies.end(), target) == src.bodies.end()) return false;
  bool inShard = false;
  for (const auto& sh : shards()) if (std::find(sh.second.begin(), sh.second.end(), target) != sh.second.end()) inShard = true;
  if (!inShard) return false;
  lo = std::max(etOfYear(firstDecade), etOfYear(src.y0));
  hi = std::min(etOfYear(lastDecade + 10), etOfYear(src.y1));
  return lo < hi && d1 >= lo && d0 <= hi;
}
}  // namespace

// config -> one file-record request per binary kernel + state.
extern "C" int plan_kernels() {
  const Json config = json("config");
  CHECK(config.is_object(), "Exactly one configuration object is required.");
  std::vector<Json> requests;
  Json state = {{"stage", 1}, {"pending", Json::array()}, {"daf", Json::array()}};
  for (const auto& k : kernels()) {
    requests.push_back(rangeRequest(k.url, 0, kRecord - 1));
    state["pending"].push_back({{"kind", "file"}, {"daf", state["daf"].size()}});
    state["daf"].push_back({{"file", k.file}, {"url", k.url}, {"pck", k.pck}, {"summaries", Json::array()}, {"records", Json::object()}});
  }
  CHECK(emit(requests, state), error);
  return 0;
}

// state + responses -> next requests + state (four stages, see the top).
extern "C" int advance() {
  Json state = json("state");
  CHECK(state.is_object() && state.contains("stage") && state["stage"].is_number_integer(), "A stage state is required.");
  const int stage = state["stage"].get<int>();
  CHECK(stage >= 1 && stage <= 4, "advance runs after stages 1 to 4.");
  const auto& pending = state["pending"];
  std::vector<Response> rs;
  CHECK(responses(pending.size(), rs), error);
  const auto ks = kernels();

  if (stage == 1) {
    size_t unchanged = 0;
    for (const auto& r : rs) if (r.status == 304) ++unchanged;
    if (unchanged == rs.size()) {
      // Every source answered 304 to its own validator: nothing to publish.
      return output("status", {{"status", 304}, {"unchanged", true}, {"skipped", "not-modified"}}) < 0 ? 1 : 0;
    }
    CHECK(unchanged == 0, "Some kernels changed and some did not between requests; the next cycle retries.");
  }
  for (const auto& r : rs) CHECK(r.status == 206 || r.status == 200, "A NAIF/SSD request did not succeed; the published kernels stay.");

  std::vector<Json> requests;
  Json next = Json::array();
  auto& dafs = state["daf"];
  // Apply this stage's responses.
  for (size_t i = 0; i < rs.size(); ++i) {
    const auto& p = pending[i];
    const std::string kind = p["kind"];
    const auto& r = rs[i];
    if (kind == "file") {
      CHECK(r.length >= kRecord, "A DAF file record is short.");
      auto& d = dafs[p["daf"].get<size_t>()];
      const std::string id(reinterpret_cast<const char*>(r.body), 8), fmt(reinterpret_cast<const char*>(r.body + 88), 8);
      CHECK(id == (d["pck"].get<bool>() ? "DAF/PCK " : "DAF/SPK "), "A kernel is not the DAF type its name says.");
      CHECK(fmt == "LTL-IEEE", "Only little-endian IEEE DAFs are read.");
      const int nd = i32(r.body + 8), ni = i32(r.body + 12);
      CHECK(nd == 2 && ni == (d["pck"].get<bool>() ? 5 : 6), "Unexpected DAF summary shape.");
      d["ni"] = ni; d["fward"] = i32(r.body + 76); d["bward"] = i32(r.body + 80);
      CHECK(d["fward"].get<int>() > 1 && d["bward"].get<int>() >= d["fward"].get<int>(), "Invalid DAF summary chain.");
    } else if (kind == "summary") {
      CHECK(r.length >= 2 * kRecord, "A DAF summary record and its name record are short.");
      auto& d = dafs[p["daf"].get<size_t>()];
      CHECK(readSummaryRecord(r.body, d["ni"].get<int>(), d, p["record"].get<int>()), error);
    } else if (kind == "dir") {
      CHECK(r.length == 32, "A segment directory is not four words.");
      auto& s = dafs[p["daf"].get<size_t>()]["summaries"][p["summary"].get<size_t>()];
      s["dir"] = {f64(r.body), f64(r.body + 8), f64(r.body + 16), f64(r.body + 24)};
    } else if (kind == "text") {
      CHECK(r.status == 200 && r.length > 0, "A text kernel did not download whole.");
      state["texts"][p["name"].get<std::string>()] = b64(r.body, r.length);
    } else {
      return fail("Unknown pending request kind.");
    }
  }

  // Plan the next stage.
  if (stage == 1) {
    for (size_t i = 0; i < dafs.size(); ++i) {
      const int fw = dafs[i]["fward"], bw = dafs[i]["bward"];
      std::vector<int> recs = {fw};
      if (bw != fw) recs.push_back(bw);
      for (int rec : recs) {
        // The summary record and the name record that follows it.
        requests.push_back(rangeRequest(dafs[i]["url"], size_t(rec - 1) * kRecord, size_t(rec + 1) * kRecord - 1));
        next.push_back({{"kind", "summary"}, {"daf", i}, {"record", rec}});
      }
    }
  } else if (stage == 2 || stage == 3) {
    for (size_t i = 0; i < dafs.size(); ++i) {
      auto& d = dafs[i];
      // Walk the chain from both ends; ask for what is missing (stage 2 only).
      std::vector<int> missing;
      int rec = d["fward"];
      for (int guard = 0; rec != 0 && guard < 8; ++guard) {
        const std::string key = std::to_string(rec);
        if (!d["records"].contains(key)) { missing.push_back(rec); break; }
        rec = d["records"][key]["next"];
      }
      rec = d["bward"];
      for (int guard = 0; rec != 0 && guard < 8; ++guard) {
        const std::string key = std::to_string(rec);
        if (!d["records"].contains(key)) { if (std::find(missing.begin(), missing.end(), rec) == missing.end()) missing.push_back(rec); break; }
        rec = d["records"][key]["prev"];
      }
      if (!missing.empty()) {
        CHECK(stage == 2, "A kernel has more than four summary records; this module reads at most four.");
        for (int m : missing) {
          requests.push_back(rangeRequest(d["url"], size_t(m - 1) * kRecord, size_t(m + 1) * kRecord - 1));
          next.push_back({{"kind", "summary"}, {"daf", i}, {"record", m}});
        }
      }
      for (size_t j = 0; j < d["summaries"].size(); ++j) {
        auto& s = d["summaries"][j];
        double lo, hi;
        if (s.contains("dir") || !needed(ks[i], i, s, lo, hi)) continue;
        const int type = d["pck"].get<bool>() ? s["ic"][2].get<int>() : s["ic"][3].get<int>();
        const int frame = d["pck"].get<bool>() ? s["ic"][1].get<int>() : s["ic"][2].get<int>();
        CHECK(type == 2 || (!d["pck"].get<bool>() && type == 3), "A needed segment is outside the module's type-2/3 contract.");
        CHECK(frame == 1, "A needed segment is not in J2000.");
        const int end = d["pck"].get<bool>() ? s["ic"][4].get<int>() : s["ic"][5].get<int>();
        requests.push_back(rangeRequest(d["url"], size_t(end - 4) * 8, size_t(end) * 8 - 1));
        next.push_back({{"kind", "dir"}, {"daf", i}, {"summary", j}});
      }
    }
    if (stage == 3) {
      for (const auto& t : texts()) {
        requests.push_back(wholeRequest(t.second));
        next.push_back({{"kind", "text"}, {"name", t.first}});
      }
    }
  } else {  // stage 4: one record window per needed segment
    for (size_t i = 0; i < dafs.size(); ++i) {
      auto& d = dafs[i];
      for (size_t j = 0; j < d["summaries"].size(); ++j) {
        auto& s = d["summaries"][j];
        double lo, hi;
        if (!needed(ks[i], i, s, lo, hi)) continue;
        CHECK(s.contains("dir"), "A needed segment has no directory.");
        const double init = s["dir"][0], intlen = s["dir"][1];
        const int rsize = int(std::lround(s["dir"][2].get<double>())), n = int(std::lround(s["dir"][3].get<double>()));
        CHECK(intlen > 0 && rsize > 2 && n > 0, "A segment directory is invalid.");
        const double a = std::max(lo, s["dc"][0].get<double>()), b = std::min(hi, s["dc"][1].get<double>());
        int first = std::max(0, int(std::floor((a - init) / intlen)));
        int last = std::min(n, int(std::floor((b - init) / intlen)) + 1);
        CHECK(first < last, "A needed segment window is empty.");
        const int begin = d["pck"].get<bool>() ? s["ic"][3].get<int>() : s["ic"][4].get<int>();
        const size_t b0 = size_t(begin - 1 + first * rsize) * 8, b1 = size_t(begin - 1 + last * rsize) * 8 - 1;
        CHECK(b1 - b0 + 1 <= maxRangeBytes, "A segment window is larger than one range.");
        s["window"] = {first, last};
        requests.push_back(rangeRequest(d["url"], b0, b1));
        next.push_back({{"kind", "window"}, {"daf", i}, {"summary", j}});
      }
    }
  }
  state["stage"] = stage + 1;
  state["pending"] = next;
  CHECK(emit(requests, state), error);
  return 0;
}

namespace {
struct Segment { std::vector<double> dc; std::vector<int32_t> ic; std::string name; std::vector<double> data; };

// A new DAF holding `segments`, the summary and name records first, then the
// data. ND=2; NI=6 (SPK) or 5 (PCK).
std::vector<uint8_t> writeDaf(bool pck, const std::string& internalName, const std::vector<Segment>& segments) {
  const int ni = pck ? 5 : 6, ss = 2 + (ni + 1) / 2, perRecord = (128 - 3) / ss;
  const int summaryRecords = std::max<int>(1, int((segments.size() + perRecord - 1) / perRecord));
  const int firstData = 2 + 2 * summaryRecords;  // record number of the first data record
  size_t words = 0;
  for (const auto& s : segments) words += s.data.size();
  const size_t dataBytes = words * 8;
  const size_t total = size_t(firstData - 1) * kRecord + (dataBytes + kRecord - 1) / kRecord * kRecord;
  std::vector<uint8_t> f(total, 0);
  // File record.
  std::memcpy(f.data(), pck ? "DAF/PCK " : "DAF/SPK ", 8);
  putI32(f, 8, 2); putI32(f, 12, ni);
  std::string ifn = internalName; ifn.resize(60, ' ');
  std::memcpy(f.data() + 16, ifn.data(), 60);
  putI32(f, 76, 2); putI32(f, 80, 2 + 2 * (summaryRecords - 1));
  putI32(f, 84, int32_t(size_t(firstData - 1) * 128 + words + 1));
  std::memcpy(f.data() + 88, "LTL-IEEE", 8);
  static const uint8_t ftp[28] = {'F','T','P','S','T','R',':','\r',':','\n',':','\r','\n',':','\r',0,':',0x81,':',0x10,0xce,':','E','N','D','F','T','P'};
  std::memcpy(f.data() + 699, ftp, 28);
  // Summary and name records.
  size_t address = size_t(firstData - 1) * 128 + 1;
  for (int r = 0; r < summaryRecords; ++r) {
    const size_t sum = size_t(1 + 2 * r) * kRecord, names = sum + kRecord;
    const size_t from = size_t(r) * perRecord, to = std::min(segments.size(), from + perRecord);
    putF64(f, sum, r + 1 < summaryRecords ? 2 + 2 * (r + 1) : 0);
    putF64(f, sum + 8, r > 0 ? 2 + 2 * (r - 1) : 0);
    putF64(f, sum + 16, double(to - from));
    std::memset(f.data() + names, ' ', 1000);
    for (size_t i = from; i < to; ++i) {
      const auto& s = segments[i];
      const size_t at = sum + 24 + (i - from) * ss * 8;
      putF64(f, at, s.dc[0]); putF64(f, at + 8, s.dc[1]);
      std::vector<int32_t> ic = s.ic;
      ic[ni - 2] = int32_t(address);
      ic[ni - 1] = int32_t(address + s.data.size() - 1);
      for (int j = 0; j < ni; ++j) putI32(f, at + 16 + j * 4, ic[j]);
      std::string name = s.name; name.resize(size_t(ss) * 8, ' ');
      std::memcpy(f.data() + names + (i - from) * ss * 8, name.data(), name.size());
      for (size_t w = 0; w < s.data.size(); ++w) putF64(f, (address - 1 + w) * 8, s.data[w]);
      address += s.data.size();
    }
  }
  return f;
}

int pushFile(const std::string& name, const std::vector<uint8_t>& bytes) {
  // One frame per file: u32 name length, name, bytes.
  std::vector<uint8_t> frame(4 + name.size() + bytes.size());
  const uint32_t n = uint32_t(name.size());
  std::memcpy(frame.data(), &n, 4);
  std::memcpy(frame.data() + 4, name.data(), name.size());
  if (!bytes.empty()) std::memcpy(frame.data() + 4 + name.size(), bytes.data(), bytes.size());
  return plugin_push_output_ex("file", nullptr, nullptr, PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY, nullptr, 0, 1, frame.data(), frame.size());
}
}  // namespace

// state + windows -> one file frame per decade shard and text kernel + job.
extern "C" int build_kernels() {
  Json state = json("state");
  CHECK(state.is_object() && state.value("stage", 0) == 5, "build_kernels runs after the window stage.");
  const auto& pending = state["pending"];
  std::vector<Response> rs;
  CHECK(responses(pending.size(), rs), error);
  for (const auto& r : rs) CHECK(r.status == 206 || r.status == 200, "A record window did not download; the published kernels stay.");
  auto& dafs = state["daf"];
  // window bytes per (daf, summary)
  std::map<std::pair<size_t, size_t>, Response> windows;
  for (size_t i = 0; i < rs.size(); ++i) {
    CHECK(pending[i]["kind"] == "window", "Unexpected request in the window stage.");
    const size_t d = pending[i]["daf"], s = pending[i]["summary"];
    const auto& w = dafs[d]["summaries"][s]["window"];
    const int rsize = int(std::lround(dafs[d]["summaries"][s]["dir"][2].get<double>()));
    CHECK(rs[i].length == size_t(w[1].get<int>() - w[0].get<int>()) * rsize * 8, "A record window has the wrong length.");
    windows[{d, s}] = rs[i];
  }
  const auto ks = kernels();
  Json manifest = Json::array();
  size_t files = 0;

  for (int decade = firstDecade; decade <= lastDecade; decade += 10) {
    const double first = etOfYear(decade), last = etOfYear(decade + 10);
    // The lunar orientation PCK (pckw02 semantics: whole records, MID/RADIUS rewritten).
    {
      std::vector<Segment> segs;
      const size_t d = ks.size() - 1;
      for (size_t j = 0; j < dafs[d]["summaries"].size(); ++j) {
        const auto& s = dafs[d]["summaries"][j];
        if (!windows.count({d, j})) continue;
        const double d0 = s["dc"][0], d1 = s["dc"][1];
        if (d1 < first || d0 > last) continue;
        const double init = s["dir"][0], intlen = s["dir"][1];
        const int rsize = int(std::lround(s["dir"][2].get<double>())), n = int(std::lround(s["dir"][3].get<double>()));
        const int i0 = std::max(0, int(std::floor((first - init) / intlen)));
        const int i1 = std::min(n, int(std::ceil((last - init) / intlen)));
        const int w0 = s["window"][0];
        CHECK(i0 >= w0 && i1 <= s["window"][1].get<int>(), "A lunar decade falls outside its fetched window.");
        const auto& r = windows[{d, j}];
        Segment seg;
        const double btime = init + i0 * intlen, radius = intlen / 2;
        seg.dc = {btime, init + i1 * intlen};
        seg.ic = {s["ic"][0].get<int>(), s["ic"][1].get<int>(), 2, 0, 0};
        seg.name = s.value("name", std::string());
        for (int rec = i0; rec < i1; ++rec) {
          const uint8_t* p = r.body + size_t(rec - w0) * rsize * 8;
          seg.data.push_back(btime + radius + (rec - i0) * intlen);
          seg.data.push_back(radius);
          for (int w = 2; w < rsize; ++w) seg.data.push_back(f64(p + size_t(w) * 8));
        }
        seg.data.insert(seg.data.end(), {btime, intlen, double(rsize), double(i1 - i0)});
        segs.push_back(std::move(seg));
      }
      if (!segs.empty()) {
        const std::string name = "moon-pa-" + std::to_string(decade) + ".bpc";
        const auto bytes = writeDaf(true, "MOON PA " + std::to_string(decade) + "-" + std::to_string(decade + 10), segs);
        CHECK(pushFile(name, bytes) >= 0, "Could not emit a kernel file.");
        manifest.push_back({{"file", name}, {"bytes", bytes.size()}, {"sha256", ephem::sha256_hex(bytes.data(), bytes.size())},
                            {"coverage", {std::to_string(decade) + "-01-01 TDB", std::to_string(decade + 10) + "-01-01 TDB"}}});
        ++files;
      }
    }
    // The SPK shards (spksub semantics: the decade cut from each source's records).
    for (const auto& shard : shards()) {
      std::vector<Segment> segs;
      for (size_t d = 0; d + 1 < ks.size(); ++d) {
        const auto& src = sources()[d];
        const double lo = std::max(first, etOfYear(src.y0)), hi = std::min(last, etOfYear(src.y1));
        if (lo >= hi) continue;
        for (size_t j = 0; j < dafs[d]["summaries"].size(); ++j) {
          const auto& s = dafs[d]["summaries"][j];
          const int target = s["ic"][0];
          if (std::find(src.bodies.begin(), src.bodies.end(), target) == src.bodies.end()) continue;
          if (std::find(shard.second.begin(), shard.second.end(), target) == shard.second.end()) continue;
          const double d0 = s["dc"][0], d1 = s["dc"][1];
          if (d1 < lo || d0 > hi) continue;
          CHECK(windows.count({d, j}), "A shard segment has no fetched window.");
          const double a = std::max(lo, d0), b = std::min(hi, d1);
          const double init = s["dir"][0], intlen = s["dir"][1];
          const int rsize = int(std::lround(s["dir"][2].get<double>())), n = int(std::lround(s["dir"][3].get<double>()));
          const int i0 = std::max(0, int(std::floor((a - init) / intlen)));
          const int i1 = std::min(n, int(std::floor((b - init) / intlen)) + 1);
          const int w0 = s["window"][0];
          CHECK(i0 >= w0 && i1 <= s["window"][1].get<int>(), "A decade falls outside its fetched window.");
          const auto& r = windows[{d, j}];
          Segment seg;
          seg.dc = {a, b};
          seg.ic = {s["ic"][0].get<int>(), s["ic"][1].get<int>(), s["ic"][2].get<int>(), s["ic"][3].get<int>(), 0, 0};
          seg.name = s.value("name", std::string());
          const uint8_t* p = r.body + size_t(i0 - w0) * rsize * 8;
          for (size_t w = 0; w < size_t(i1 - i0) * rsize; ++w) seg.data.push_back(f64(p + w * 8));
          seg.data.insert(seg.data.end(), {init + i0 * intlen, intlen, double(rsize), double(i1 - i0)});
          segs.push_back(std::move(seg));
        }
      }
      if (segs.empty()) continue;
      const std::string name = std::string(shard.first) + "-" + std::to_string(decade) + ".bsp";
      const auto bytes = writeDaf(false, std::string(shard.first) + " " + std::to_string(decade) + "-" + std::to_string(decade + 10), segs);
      CHECK(pushFile(name, bytes) >= 0, "Could not emit a kernel file.");
      manifest.push_back({{"file", name}, {"bytes", bytes.size()}, {"sha256", ephem::sha256_hex(bytes.data(), bytes.size())},
                          {"coverage", {std::to_string(decade) + "-01-01 TDB", std::to_string(decade + 10) + "-01-01 TDB"}}});
      ++files;
    }
  }
  for (const auto& t : texts()) {
    std::vector<uint8_t> bytes;
    CHECK(state.contains("texts") && state["texts"].contains(t.first) && unb64(state["texts"][t.first], bytes), "A text kernel is missing.");
    CHECK(pushFile(t.first, bytes) >= 0, "Could not emit a kernel file.");
    manifest.push_back({{"file", t.first}, {"bytes", bytes.size()}, {"sha256", ephem::sha256_hex(bytes.data(), bytes.size())}, {"coverage", nullptr}});
    ++files;
  }
  CHECK(files + 2 <= maxFrames, "More kernel files than the runtime's frame budget.");
  Json inputs = Json::array();
  for (const auto& d : dafs) inputs.push_back({{"file", d["file"]}, {"url", d["url"]}});
  for (const auto& t : texts()) inputs.push_back({{"file", t.first}, {"url", t.second}});
  const Json job = {{"provider_id", providerId}, {"source_name", sourceName}, {"files", manifest}, {"inputs", inputs}};
  return output("job", job) < 0 ? 1 : 0;
}

// job + receipt + one "added" frame per file ({name, cid, size}) -> one $PNM
// per kernel file, meta and report.
extern "C" int announce_kernels() {
  const Json job = json("job"), receipt = json("receipt");
  CHECK(job.is_object() && job.contains("files") && job["files"].is_array(), "The build job is required.");
  CHECK(receipt.is_object() && receipt.contains("retrieved_at_ms") && receipt["retrieved_at_ms"].is_number_integer(), "Invalid retrieval epoch.");
  const auto peer = receipt.value("producer_peer_id", std::string());
  CHECK(!peer.empty() && peer.size() <= 128, "An authenticated producer peer ID is required.");
  std::map<std::string, Json> added;
  for (const auto* f : frames("added")) {
    const Json a = Json::parse(f->payload, f->payload + f->payload_length, nullptr, false);
    CHECK(a.is_object() && a.contains("name") && a.contains("cid") && a["cid"].is_string(), "An IPFS add result is malformed.");
    added[a["name"].get<std::string>()] = a;
  }
  CHECK(added.size() == job["files"].size(), "Every kernel file must be added to IPFS before it is announced.");
  const int64_t ms = receipt["retrieved_at_ms"].get<int64_t>();
  // ISO 8601 UTC of the retrieval.
  const int64_t sec = ms / 1000, day = sec / 86400, rem = sec % 86400;
  int64_t z = day + 719468; const int64_t era = (z >= 0 ? z : z - 146096) / 146097;
  const unsigned doe = unsigned(z - era * 146097), yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
  const unsigned doy = doe - (365 * yoe + yoe / 4 - yoe / 100), mp = (5 * doy + 2) / 153;
  const unsigned dd = doy - (153 * mp + 2) / 5 + 1, mm = mp < 10 ? mp + 3 : mp - 9;
  const int64_t yy = int64_t(yoe) + era * 400 + (mm <= 2);
  char when[32];
  std::snprintf(when, sizeof when, "%04lld-%02u-%02uT%02lld:%02lld:%02lldZ", (long long)yy, mm, dd, (long long)(rem / 3600), (long long)(rem % 3600 / 60), (long long)(rem % 60));

  std::vector<uint8_t> stream;
  std::string digest;
  for (const auto& file : job["files"]) {
    const std::string name = file["file"], sha = file["sha256"];
    const auto& a = added[name];
    CHECK(a.value("bytes", int64_t(-1)) == file["bytes"].get<int64_t>(), "An added file's length differs from the built file.");
    const std::string cid = a["cid"];
    flatbuffers::FlatBufferBuilder b(256);
    const auto addr = b.CreateString("/ipfs/" + cid);
    const auto ts = b.CreateString(when);
    const auto cidOffset = b.CreateString(cid);
    const auto fileName = b.CreateString(name);
    const auto fileId = b.CreateString(std::string(providerId) + ":" + sourceName + ":" + name + ":" + sha);
    PNMBuilder pnm(b);
    pnm.add_MULTIFORMAT_ADDRESS(addr);
    pnm.add_PUBLISH_TIMESTAMP(ts);
    pnm.add_CID(cidOffset);
    pnm.add_FILE_NAME(fileName);
    pnm.add_FILE_ID(fileId);
    FinishSizePrefixedPNMBuffer(b, pnm.Finish());
    stream.insert(stream.end(), b.GetBufferPointer(), b.GetBufferPointer() + b.GetSize());
    digest += name + ":" + sha + "\n";
  }
  const std::string batch = ephem::sha256_hex(reinterpret_cast<const uint8_t*>(digest.data()), digest.size());
  const Json meta = {{"schema", "PNM.fbs"}, {"batch_id", batch}, {"provider_id", providerId}, {"source_name", sourceName},
                     {"source_url", "https://naif.jpl.nasa.gov/pub/naif/generic_kernels/"}, {"source_peer", peer},
                     {"reconcile", "current"}, {"origin_id", "naif.jpl.nasa.gov"}, {"origin_name", "NASA/JPL NAIF"},
                     {"dataset_id", "naif/ssb-kernels"}, {"terms_url", "https://naif.jpl.nasa.gov/naif/rules.html"},
                     {"citation", credit}, {"licence", licence}};
  const Json report = {{"files", job["files"].size()}, {"batch_id", batch}, {"inputs", job["inputs"]}, {"outputs", job["files"]},
                       {"retrieved_at", when}};
  if (output("meta", meta) < 0 || output("report", report) < 0) return 1;
  return plugin_push_output_ex("records", "PNM.fbs", "$PNM", PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, "PNM", 0, 0,
                               stream.data(), stream.size()) < 0 ? 1 : 0;
}
