// data-source/ilrs-station-coordinates: ILRS station coordinates (pos+eop SINEX) as SDS ground station definitions.
//
//   read_sinex   the HttpResponse (HRSP) holding one ILRS pos+eop SINEX file -> one $GST per station, one $PVN for the
//                file, and a FlowNotice (FNTC) report
//
// Typed contracts 1.0 (FlatBuffers only): the input is the HttpResponse hostcap/http-request answers, BODY the SINEX text
// verbatim (decompressed: the data centres serve .snx.gz, and the gunzip belongs to the host flow, as the download, the
// schedule and the archive do). HTTP 304 gives one FlowNotice (Unchanged) and no record; another status or a transport
// ERROR is refused. No hostcalls. Errors are flags (an invoke error code and message), never exceptions.
//
// Authority: the SINEX format, version 2.02 (IERS, https://www.iers.org/IERS/EN/Organization/AnalysisCoordinator/SinexFormat/
// sinex.html). Blocks read: the %=SNX header, SITE/ID, SOLUTION/EPOCHS, SITE/ECCENTRICITY and SOLUTION/ESTIMATE; every
// other block is passed over and counted. A station is one SITE CODE, POINT CODE and SOLUTION NUMBER with STAX, STAY and
// STAZ in SOLUTION/ESTIMATE. Its $GST holds what the file states and nothing computed: the position (metres) and its
// standard deviations at the estimate's reference epoch, the velocity (VELX, VELY, VELZ, metres per year) when the file
// estimates it, else NaN (the ILRS weekly solution estimates none, and a zero would claim the station does not move), the
// eccentricity of SITE/ECCENTRICITY (XYZ as given; UNE as NEU, each component in its own field), the DOMES number, the
// description, and the solution's data window as the definition's validity. A SINEX file does not name its terrestrial
// frame realization, so FRAME_REALIZATION is UNSPECIFIED: the host that knows the product's frame states it.
//
// The $PVN describes the file: SOURCE_ID the combination centre's file prefix (ilrsa, ilrsb), SOURCE_KIND Reference,
// ORIGINATOR ILRS, LICENSE_CLASS Reproducible (the ILRS states its products are not copyrighted and asks to be cited),
// SOURCE_URL and RETRIEVED_AT from the HttpResponse, SOURCE_VERSION the header's agency and creation time. SOURCE_SHA256 is
// empty: the module sees the decompressed text, not the bytes as retrieved.
//
// Refused whole, with no partial output: a body that is gzip, holds a NUL, has no %=SNX header or no %ENDSNX (truncated),
// leaves a block open, has no SOLUTION/ESTIMATE, gives a station only part of its position or velocity, gives them on
// different reference epochs or in another unit, or holds a number or an epoch that does not read.

#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <limits>
#include <map>
#include <memory>
#include <sstream>
#include <string>
#include <tuple>
#include <vector>

#include <HttpResponse_generated.h>
#include <FlowNotice_generated.h>

using Json = nlohmann::json;
namespace R = sdn::runtime;

namespace {

constexpr size_t kMaxBytes = 64u * 1024 * 1024;
constexpr size_t kMaxStations = 1024;
constexpr const char* kPluginId = "com.digitalarsenal.data-source.ilrs-station-coordinates";
constexpr const char* kVersion = "0.1.0";

int fail(const char* code, const std::string& message) {
  plugin_set_error(code, message.c_str());
  return 1;
}

std::string trim(const std::string& s) {
  const auto a = s.find_first_not_of(' ');
  if (a == std::string::npos) return std::string();
  return s.substr(a, s.find_last_not_of(' ') - a + 1);
}

// Columns [from, from + width) of a fixed-format line (0-based), trimmed; empty past the end of the line.
std::string column(const std::string& line, size_t from, size_t width) { return from >= line.size() ? std::string() : trim(line.substr(from, width)); }

bool real(const std::string& s, double* out) {
  if (s.empty() || s.size() > 40) return false;
  for (char c : s) {
    if (!((c >= '0' && c <= '9') || c == '+' || c == '-' || c == '.' || c == 'e' || c == 'E')) return false;
  }
  char* end = nullptr;
  const double v = std::strtod(s.c_str(), &end);
  if (end != s.c_str() + s.size() || !std::isfinite(v)) return false;
  *out = v;
  return true;
}

// A SINEX epoch "YY:DDD:SSSSS" (YY <= 50 is 20YY, else 19YY; 00:000:00000 is open). Kept as text; key() orders epochs.
struct Epoch {
  long year = 0, day = 0, seconds = 0;
  bool open = false;
  int64_t key() const { return (static_cast<int64_t>(year) * 1000 + day) * 100000 + seconds; }
};
bool epoch(const std::string& s, Epoch* out) {
  if (s.size() != 12 || s[2] != ':' || s[6] != ':') return false;
  for (size_t i : {0, 1, 3, 4, 5, 7, 8, 9, 10, 11}) {
    if (s[i] < '0' || s[i] > '9') return false;
  }
  const long yy = std::strtol(s.substr(0, 2).c_str(), nullptr, 10);
  out->day = std::strtol(s.substr(3, 3).c_str(), nullptr, 10);
  out->seconds = std::strtol(s.substr(7, 5).c_str(), nullptr, 10);
  out->open = yy == 0 && out->day == 0 && out->seconds == 0;
  if (out->open) return true;
  out->year = yy <= 50 ? 2000 + yy : 1900 + yy;
  const long days_in_year = sdn_time::leap_year(out->year) ? 366 : 365;
  return out->day >= 1 && out->day <= days_in_year && out->seconds <= 86400;
}
// ISO 8601 "YYYY-MM-DDTHH:MM:SS" of a SINEX epoch (calendar arithmetic only); empty for an open epoch.
std::string iso(const Epoch& e) {
  if (e.open) return std::string();
  int64_t y, m, d;
  sdn_time::civil_from_days(sdn_time::days_from_civil(e.year, 1, 1) + e.day - 1 + e.seconds / 86400, &y, &m, &d);
  const long s = e.seconds % 86400;
  char out[32];
  std::snprintf(out, sizeof(out), "%04lld-%02lld-%02lldT%02ld:%02ld:%02ld", static_cast<long long>(y), static_cast<long long>(m), static_cast<long long>(d), s / 3600, s / 60 % 60, s % 60);
  return out;
}

using Key = std::tuple<std::string, std::string, std::string>;  // SITE CODE, POINT CODE, SOLUTION NUMBER
struct Site { std::string domes, technique, description; };
struct Eccentricity { Epoch start, end; std::string system; double v[3] = {0, 0, 0}; };
struct Parameter { double value = 0, sigma = 0; std::string unit, ref_epoch; Epoch ref; bool set = false; };
struct Station {
  Key key;
  Parameter sta[3], vel[3];
  std::string mean_epoch, data_start, data_end;
};

std::string item(const std::string& name, const Json& value) { return name + "=" + (value.is_string() ? value.get<std::string>() : value.dump()); }

int push_notice(R::flowNoticeKind kind, const char* reason, uint64_t count, std::vector<std::string> items) {
  R::FlowNoticeT notice;
  notice.KIND = kind;
  notice.SCHEMA = "GST";
  notice.SOURCE_NAME = "ilrs-sinex";
  notice.REASON = reason;
  notice.COUNT = count;
  notice.ITEMS = std::move(items);
  flatbuffers::FlatBufferBuilder b(1024);
  R::FinishFlowNoticeBuffer(b, R::FlowNotice::Pack(b, &notice));
  return plugin_push_output_ex("report", "FlowNotice.fbs", R::FlowNoticeIdentifier(), PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, "FlowNotice", 0, 0,
                               b.GetBufferPointer(), b.GetSize());
}

// RFC 3339 UTC with fixed milliseconds, from milliseconds since 1970.
std::string rfc3339_ms(uint64_t ms) { return sdn_time::format_iso_micro(static_cast<int64_t>(ms) * 1000).substr(0, 23) + "Z"; }

}  // namespace

extern "C" int read_sinex(void) {
  if (plugin_get_input_count() != 1) return fail("invalid-sinex", "Exactly one HttpResponse holding a SINEX file is required.");
  const auto* input = plugin_get_input_frame(0);
  if (!input || !input->port_id || std::strcmp(input->port_id, "source") || !input->payload || !input->payload_length) {
    return fail("missing-response-frame", "The parser requires the HttpResponse frame on 'source'.");
  }
  flatbuffers::Verifier verifier(input->payload, input->payload_length, 64, 1000000, false);
  if (!R::VerifyHttpResponseBuffer(verifier)) return fail("invalid-response-frame", "The source frame is not an HttpResponse (HRSP).");
  const R::HttpResponse* response = R::GetHttpResponse(input->payload);
  const std::string url = response->URL() ? response->URL()->str() : std::string();
  if (response->ERROR() && response->ERROR()->size()) return fail("fetch-failed", "The SINEX request failed: " + response->ERROR()->str());
  if (response->STATUS() == 304) return push_notice(R::flowNoticeKind_Unchanged, "not-modified", 1, {url}) < 0 ? 1 : 0;
  if (response->STATUS() != 200) return fail("fetch-failed", "The SINEX source returned HTTP status " + std::to_string(response->STATUS()) + ".");
  const auto* body = response->BODY();
  if (!body || body->size() == 0 || body->size() > kMaxBytes) return fail("invalid-sinex", "The source must be one bounded SINEX file.");
  if (body->size() >= 2 && body->data()[0] == 0x1f && body->data()[1] == 0x8b) return fail("invalid-sinex", "The body is gzip: the host decompresses .snx.gz before the parser.");
  const std::string text(reinterpret_cast<const char*>(body->data()), body->size());
  if (text.find('\0') != std::string::npos) return fail("invalid-sinex", "The SINEX file contains an embedded NUL.");

  std::string header, block;
  bool ended = false;
  std::map<std::string, size_t> blocks_passed;
  std::map<Key, Site> sites;  // SITE/ID is by SITE CODE and POINT CODE; the solution number is ""
  std::map<Key, std::vector<Eccentricity>> eccentricities;
  std::map<Key, Station> stations;
  std::vector<Key> order;  // stations in the order SOLUTION/ESTIMATE first names them
  std::map<std::string, size_t> other_parameters;  // by parameter type
  size_t site_rows = 0, estimate_rows = 0;
  bool seen_estimate = false;

  std::istringstream stream(text);
  std::string line;
  size_t line_no = 0;
  while (std::getline(stream, line)) {
    ++line_no;
    if (!line.empty() && line.back() == '\r') line.pop_back();
    const std::string at = " (line " + std::to_string(line_no) + ")";
    if (line_no == 1) {
      if (line.rfind("%=SNX ", 0) != 0) return fail("invalid-sinex", "The file does not begin with a SINEX header (%=SNX).");
      header = line;
      continue;
    }
    if (ended) {
      if (!trim(line).empty()) return fail("invalid-sinex", "Lines follow %ENDSNX" + at + ".");
      continue;
    }
    if (line.rfind("%ENDSNX", 0) == 0) {
      if (!block.empty()) return fail("invalid-sinex", "Block " + block + " is not closed before %ENDSNX.");
      ended = true;
      continue;
    }
    if (line.empty() || line[0] == '*') continue;
    if (line[0] == '+') {
      if (!block.empty()) return fail("invalid-sinex", "Block " + trim(line.substr(1)) + " opens inside " + block + at + ".");
      block = trim(line.substr(1));
      if (block == "SOLUTION/ESTIMATE") seen_estimate = true;
      continue;
    }
    if (line[0] == '-') {
      if (trim(line.substr(1)) != block) return fail("invalid-sinex", "Block end " + trim(line.substr(1)) + " does not close " + (block.empty() ? "a block" : block) + at + ".");
      block.clear();
      continue;
    }
    if (line[0] != ' ') return fail("invalid-sinex", "A data line does not begin with a blank" + at + ".");
    if (block.empty()) return fail("invalid-sinex", "A data line stands outside a block" + at + ".");
    const std::string code = column(line, 1, 4), point = column(line, 6, 2);
    if (block == "SITE/ID") {
      // CODE PT DOMES T DESCRIPTION(22) LON LAT HEIGHT
      ++site_rows;
      sites[{code, point, ""}] = Site{column(line, 9, 9), column(line, 19, 1), column(line, 21, 22)};
    } else if (block == "SOLUTION/EPOCHS") {
      // CODE PT SOLN T DATA_START DATA_END MEAN_EPOCH
      Epoch a, b, m;
      if (!epoch(column(line, 16, 12), &a) || !epoch(column(line, 29, 12), &b) || !epoch(column(line, 42, 12), &m)) return fail("invalid-sinex", "An epoch in SOLUTION/EPOCHS does not read" + at + ".");
      Station& s = stations[{code, point, column(line, 9, 4)}];
      s.data_start = iso(a);
      s.data_end = iso(b);
      s.mean_epoch = iso(m);
    } else if (block == "SITE/ECCENTRICITY") {
      // CODE PT SOLN T DATA_START DATA_END REF(UNE|XYZ) V1 V2 V3
      Eccentricity e;
      e.system = column(line, 42, 3);
      if (!epoch(column(line, 16, 12), &e.start) || !epoch(column(line, 29, 12), &e.end)) return fail("invalid-sinex", "An epoch in SITE/ECCENTRICITY does not read" + at + ".");
      if (e.system != "XYZ" && e.system != "UNE") return fail("invalid-sinex", "An eccentricity is in neither UNE nor XYZ" + at + ".");
      if (!real(column(line, 46, 8), &e.v[0]) || !real(column(line, 55, 8), &e.v[1]) || !real(column(line, 64, 8), &e.v[2])) return fail("invalid-sinex", "An eccentricity does not read" + at + ".");
      eccentricities[{code, point, column(line, 9, 4)}].push_back(e);
    } else if (block == "SOLUTION/ESTIMATE") {
      // INDEX TYPE CODE PT SOLN REF_EPOCH UNIT S ESTIMATED_VALUE STD_DEV
      ++estimate_rows;
      const std::string type = column(line, 7, 6);
      const bool sta = type == "STAX" || type == "STAY" || type == "STAZ", vel = type == "VELX" || type == "VELY" || type == "VELZ";
      if (!sta && !vel) {
        ++other_parameters[type];
        continue;
      }
      const std::string code_e = column(line, 14, 4), point_e = column(line, 19, 2), soln = column(line, 22, 4);
      Parameter p;
      Epoch ref;
      if (!epoch(column(line, 27, 12), &ref) || ref.open) return fail("invalid-sinex", "The reference epoch of an estimate does not read" + at + ".");
      p.ref_epoch = iso(ref);
      p.ref = ref;
      p.unit = column(line, 40, 4);
      if (!real(column(line, 47, 21), &p.value) || !real(column(line, 69, 11), &p.sigma)) return fail("invalid-sinex", "An estimate does not read" + at + ".");
      if (p.unit != (sta ? "m" : "m/y")) return fail("invalid-sinex", "Estimate " + type + " of " + code_e + " is in " + p.unit + ", not " + (sta ? "m" : "m/y") + at + ".");
      const Key key{code_e, point_e, soln};
      if (std::find(order.begin(), order.end(), key) == order.end()) order.push_back(key);
      Station& s = stations[key];
      s.key = key;
      Parameter& slot = (sta ? s.sta : s.vel)[type[3] - 'X'];
      if (slot.set) return fail("invalid-sinex", "Estimate " + type + " of " + code_e + " is given twice" + at + ".");
      p.set = true;
      slot = p;
    } else {
      ++blocks_passed[block];
    }
  }
  if (header.empty()) return fail("invalid-sinex", "The file has no SINEX header.");
  if (!ended) return fail("invalid-sinex", "The file has no %ENDSNX: it is truncated.");
  if (!seen_estimate) return fail("invalid-sinex", "The file has no SOLUTION/ESTIMATE block.");
  if (order.empty()) return fail("invalid-sinex", "SOLUTION/ESTIMATE holds no station position.");
  if (order.size() > kMaxStations) return fail("invalid-sinex", "The file has more than 1,024 stations.");

  // %=SNX V.VV AGY YY:DDD:SSSSS AGD YY:DDD:SSSSS(start) YY:DDD:SSSSS(end) T NNNNN C S...
  std::istringstream h(header);
  std::vector<std::string> head;
  for (std::string t; h >> t;) head.push_back(t);
  Epoch created, start, end;
  if (head.size() < 9 || !epoch(head[3], &created) || !epoch(head[5], &start) || !epoch(head[6], &end)) return fail("invalid-sinex", "The SINEX header does not read.");
  const std::string file = url.substr(url.find_last_of('/') == std::string::npos ? 0 : url.find_last_of('/') + 1);
  const std::string prefix = file.substr(0, file.find('.'));
  const std::string source_id = prefix.rfind("ilrs", 0) == 0 && !prefix.empty() ? prefix : std::string("ilrs");
  const std::string stamp = head[2] + " " + head[3];

  std::vector<std::vector<uint8_t>> records;
  std::vector<std::string> per_station;
  size_t with_velocity = 0, with_eccentricity = 0;
  const double nan = std::numeric_limits<double>::quiet_NaN();
  for (const Key& key : order) {
    const Station& s = stations.at(key);
    const auto& [code, point, soln] = key;
    if (!s.sta[0].set || !s.sta[1].set || !s.sta[2].set) return fail("invalid-sinex", "Station " + code + " " + point + " has only part of its position.");
    if (s.sta[0].ref_epoch != s.sta[1].ref_epoch || s.sta[0].ref_epoch != s.sta[2].ref_epoch) return fail("invalid-sinex", "Station " + code + " " + point + " gives its position on different epochs.");
    const int vel_count = s.vel[0].set + s.vel[1].set + s.vel[2].set;
    if (vel_count != 0 && vel_count != 3) return fail("invalid-sinex", "Station " + code + " " + point + " has only part of its velocity.");
    GSTT g;
    g.STATION_ID = code;
    g.CDP_NUMBER = code;
    g.NETWORK = gstNetwork::ILRS;
    const auto site = sites.find({code, point, ""});
    if (site != sites.end()) {
      g.DOMES_NUMBER = site->second.domes;
      g.NAME = site->second.description;
    }
    g.FRAME_REALIZATION = gstFrameRealization::UNSPECIFIED;
    g.REFERENCE_EPOCH = s.sta[0].ref_epoch;
    g.POSITION_X = s.sta[0].value;
    g.POSITION_Y = s.sta[1].value;
    g.POSITION_Z = s.sta[2].value;
    g.POSITION_SIGMA_X = s.sta[0].sigma;
    g.POSITION_SIGMA_Y = s.sta[1].sigma;
    g.POSITION_SIGMA_Z = s.sta[2].sigma;
    g.VELOCITY_X = vel_count ? s.vel[0].value : nan;
    g.VELOCITY_Y = vel_count ? s.vel[1].value : nan;
    g.VELOCITY_Z = vel_count ? s.vel[2].value : nan;
    if (vel_count) ++with_velocity;
    // The eccentricity of the station's solution (or of all its solutions, "----") valid at the reference epoch; a row's end
    // 00:000:00000 is open.
    auto ecc = eccentricities.find(key);
    if (ecc == eccentricities.end()) ecc = eccentricities.find({code, point, "----"});
    if (ecc != eccentricities.end()) {
      const Eccentricity* chosen = nullptr;
      const int64_t ref = s.sta[0].ref.key();
      for (const Eccentricity& e : ecc->second) {
        if ((e.start.open || e.start.key() <= ref) && (e.end.open || e.end.key() >= ref)) {
          if (chosen) return fail("invalid-sinex", "Station " + code + " " + point + " has two eccentricities at its reference epoch.");
          chosen = &e;
        }
      }
      if (chosen) {
        ++with_eccentricity;
        if (chosen->system == "XYZ") {
          g.ECCENTRICITY_FRAME = "XYZ";
          g.ECCENTRICITY_X = chosen->v[0];
          g.ECCENTRICITY_Y = chosen->v[1];
          g.ECCENTRICITY_Z = chosen->v[2];
        } else {
          g.ECCENTRICITY_FRAME = "NEU";  // the file's UNE: up, north, east
          g.ECCENTRICITY_X = chosen->v[1];
          g.ECCENTRICITY_Y = chosen->v[2];
          g.ECCENTRICITY_Z = chosen->v[0];
        }
      }
    }
    g.VALID_FROM = iso(start);
    g.VALID_TO = iso(end);
    g.SOURCE = file.empty() ? "ILRS SINEX " + stamp : file;
    flatbuffers::FlatBufferBuilder fbb(1024);
    FinishGSTBuffer(fbb, CreateGST(fbb, &g));
    records.emplace_back(fbb.GetBufferPointer(), fbb.GetBufferPointer() + fbb.GetSize());
    const std::string k = "station." + std::to_string(records.size() - 1) + ".";
    for (std::string entry : {item(k + "code", code), item(k + "point", point), item(k + "solution", soln), item(k + "domes", g.DOMES_NUMBER), item(k + "dataStart", s.data_start),
                              item(k + "dataEnd", s.data_end), item(k + "meanEpoch", s.mean_epoch)}) {
      per_station.push_back(std::move(entry));
    }
  }

  PVNT pvn;
  pvn.SOURCE_ID = source_id;
  pvn.SOURCE_KIND = pvnSourceKind::Reference;
  pvn.ORIGINATOR = "ILRS";
  if (url.find("://") != std::string::npos) {
    const size_t host = url.find("://") + 3;
    pvn.PROVIDER_ID = url.substr(host, url.find('/', host) - host);
  }
  pvn.PRODUCER = std::string(kPluginId) + " " + kVersion;
  pvn.LICENSE_CLASS = pvnLicenseClass::Reproducible;
  pvn.LICENSE_ID = "ilrs";
  pvn.LINEAGE = "ilrs";
  pvn.SOURCE_URL = url;
  pvn.SOURCE_VERSION = stamp;
  if (response->RETRIEVED_MS()) pvn.RETRIEVED_AT = rfc3339_ms(response->RETRIEVED_MS());
  flatbuffers::FlatBufferBuilder pb(512);
  FinishPVNBuffer(pb, CreatePVN(pb, &pvn));

  std::vector<std::string> items = {item("format", head[0].substr(2) + " " + head[1]), item("agency", head[2]), item("created", iso(created)), item("solutionStart", iso(start)),
                                    item("solutionEnd", iso(end)), item("technique", head[7]), item("sites", site_rows), item("estimates", estimate_rows),
                                    item("stations", records.size()), item("stationsWithVelocity", with_velocity), item("stationsWithEccentricity", with_eccentricity),
                                    item("frameRealization", "not stated in the file")};
  for (const auto& entry : other_parameters) items.push_back(item("parametersNotRead." + entry.first, entry.second));
  for (const auto& entry : blocks_passed) items.push_back(item("blockNotRead." + entry.first, entry.second));
  items.insert(items.end(), per_station.begin(), per_station.end());
  if (push_notice(R::flowNoticeKind_Info, "ilrs-sinex", records.size(), std::move(items)) < 0) return 1;
  if (plugin_push_output_ex("provenance", "PVN.fbs", "$PVN", PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, "PVN", 0, 0, pb.GetBufferPointer(), pb.GetSize()) < 0) return 1;
  for (const auto& record : records) {
    if (plugin_push_output_ex("stations", "GST.fbs", "$GST", PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, "GST", 0, 0, record.data(), static_cast<uint32_t>(record.size())) < 0) return 1;
  }
  return 0;
}
