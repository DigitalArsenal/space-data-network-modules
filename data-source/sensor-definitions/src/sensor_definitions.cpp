// data-source/sensor-definitions: real-world sensors as SDS $SNR sensor definitions.
//
//   plan_sources   a timer tick -> the HTTP GETs of the roster (src/roster.hpp): the WMO OSCAR satellite documents and
//                  instrument pages and the MediaWiki extracts of the ground-sensor pages
//   build_sensors  the HttpResponse (HRSP) of every request -> one $SNR per sensor on a platform (lane space: satellite
//                  payloads; lane ground: ground sensors), one $PVN per source system, FlowNotice reports
//
// UNKNOWN IS ABSENT. Every value of a record is read from a source document in the run: a channel table cell of an OSCAR
// instrument page, or a Fact whose quote occurs in the document (roster.hpp). A number with no source is 0 (positive
// quantity) or NaN (signed quantity); an enum with none is UNSPECIFIED; a table with none is absent. Nothing is computed
// from a value that has no source, and a computed value says so (METHOD DERIVED in the record's NOTES).
//
// Typed contracts 1.0 (FlatBuffers only). Errors are flags (an invoke error code and message), never exceptions. The module
// has no network imports; the host executes the requests. Configuration: producer_peer_id (String, required), from
// plugin.getConfig through the typed $PIV bridge.
#include <HttpRequest_generated.h>
#include <HttpResponse_generated.h>
#include <TimerTick_generated.h>
#include <FlowNotice_generated.h>
#include <IngestRequest_generated.h>
#include <typedHostcall.hpp>

#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <limits>
#include <map>
#include <memory>
#include <set>
#include <string>
#include <vector>

namespace R = sdn::runtime;
namespace A = sdn::runtime::Aligned;
namespace T = sensortext;
using Json = nlohmann::json;

namespace {

constexpr const char* kProvider = "sensor-definitions";
constexpr const char* kPluginId = "com.digitalarsenal.data-source.sensor-definitions";
constexpr const char* kVersion = "0.1.1";
constexpr double kC = 299792458.0;  // m/s, exact
constexpr size_t kMaxResponses = 300, kMaxBody = 32u * 1024u * 1024u, kMaxRecordBytes = 8191;

constexpr const char* kSatcatUrl = "https://celestrak.org/pub/satcat.csv";
constexpr const char* kOscarSatellite = "https://space.oscar.wmo.int/api/v1/satellites/";
constexpr const char* kOscarInstrument = "https://space.oscar.wmo.int/instruments/view/";
constexpr const char* kWikiApi = "https://en.wikipedia.org/w/api.php?action=query&prop=revisions%7Cextracts&rvprop=ids%7Ctimestamp&rvslots=main&explaintext=1&exsectionformat=plain&format=json&redirects=1&titles=";

// The terms, as the sources state them.
constexpr const char* kOscarLicense = "WMO OSCAR: \"All information available on these pages may be used and redistributed freely, however, any publication using this information should acknowledge WMO.\" (https://space.oscar.wmo.int/pages/disclaimer)";
constexpr const char* kOscarAttribution = "World Meteorological Organization (WMO), OSCAR/Space";
constexpr const char* kWikiLicense = "CC-BY-SA-4.0";
constexpr const char* kSatcatLicense = "CelesTrak SATCAT: public, redistributed with citation";

int fail(const char* code, const std::string& message) {
  plugin_set_error(code, message.c_str());
  return 1;
}

std::string url_encode(const std::string& s) {
  static const char* hex = "0123456789ABCDEF";
  std::string out;
  for (unsigned char c : s) {
    if (std::isalnum(c) || c == '-' || c == '_' || c == '.' || c == '~') out += static_cast<char>(c);
    else { out += '%'; out += hex[c >> 4]; out += hex[c & 15]; }
  }
  return out;
}

std::string rfc3339_ms(uint64_t ms) { return sdn_time::format_iso_micro(static_cast<int64_t>(ms) * 1000).substr(0, 23) + "Z"; }

int push(const char* port, const char* schema, const char* identifier, const char* root, const uint8_t* data, size_t size) {
  return plugin_push_output_ex(port, schema, identifier, PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, root, 0, 0, data, size);
}

// ---- The documents of the run, by URL.
struct Doc {
  bool ok = false;  // HTTP 200, no transport error, a non-empty body
  std::string error;
  std::string body, text;  // text: plain text of an HTML page or the extract of a MediaWiki page (filled on demand)
  uint64_t retrieved_ms = 0;
  std::string sha256;
};

std::vector<const plugin_input_frame_t*> frames(const char* port) {
  std::vector<const plugin_input_frame_t*> result;
  for (uint32_t i = 0; i < plugin_get_input_count(); ++i) {
    const auto* f = plugin_get_input_frame(i);
    if (f && f->port_id && std::strcmp(f->port_id, port) == 0) result.push_back(f);
  }
  return result;
}

// ---- SATCAT: only the rows the roster names, by NORAD id, and the constellation members by name prefix.
struct SatRow {
  std::string name, object_id, type, ops, launch, decay;
  int norad = 0;
};

// Discover only roster identities through the SDK's sandboxed, parameterized SQL
// surface (as hostcap/flatsql-query does), then read each identity with source tags.
// storage.query is capped at 1,000 rows by the node: an unfiltered catalog read
// would silently omit identities. Each discovery page and exact lookup is bounded.
bool discover_satcat(const std::set<int>& wanted, const std::vector<std::string>& prefixes,
                     std::set<int>* ids, std::string* error) {
  constexpr size_t page_size = 32;
  int cursor = 0;
  for (;;) {
    sdm_piv::SqlValues values;
    values.i64(cursor);
    std::string sql = "SELECT DISTINCT NORAD_CAT_ID FROM CAT WHERE NORAD_CAT_ID > ? AND (NORAD_CAT_ID IN (";
    bool first = true;
    for (int id : wanted) { if (!first) sql += ","; first = false; sql += "?"; values.i64(id); }
    sql += ")";
    for (const auto& prefix : prefixes) { sql += " OR OBJECT_NAME LIKE ?"; values.str(prefix + "%"); }
    sql += ") ORDER BY NORAD_CAT_ID LIMIT 32";
    A::SandboxQueryParams params{};
    params.WANT = A::sandboxWant_Rows;
    params.DELIVER = A::deliverMode_Inline;
    const auto response = sdm_piv::call("storage.query_sandboxed", "SandboxQueryParams", params,
                                       {sdm_piv::raw("sql", sql), values.frame()});
    if (!response.ok()) { *error = response.error_code() + ": " + response.error_message(); return false; }
    const auto* result = response.result<A::SandboxQueryResult>("SandboxQueryResult");
    std::vector<sdm_piv::SqlValue> cells;
    const auto [columns, column_count] = response.list<A::TextValue>("columns", "TextValue");
    if (!result || result->KIND != A::sandboxWant_Rows || !sdm_piv::read_sql_values(response.raw("cells"), cells) ||
        result->ROWS != cells.size() || cells.size() > page_size ||
        (!cells.empty() && (result->COLUMNS != 1 || column_count != 1 || columns[0].VALUE.str() != "NORAD_CAT_ID"))) {
      *error = "malformed stored CAT identity discovery page"; return false;
    }
    for (const auto& cell : cells) {
      const int64_t id = cell.as_i64();
      if (cell.tag != sdm_piv::kSqlI64 || cell.payload.size() != 8 || id <= cursor || id > 2147483647) {
        *error = "CAT identity discovery is not a strictly increasing NORAD page"; return false;
      }
      cursor = static_cast<int>(id);
      ids->insert(cursor);
    }
    if (ids->size() >= 250000) { *error = "stored CAT identity discovery exceeds its catalog bound"; return false; }
    if (cells.size() < page_size) return true;
  }
}

bool read_satcat(const std::string& peer, const std::set<int>& wanted, const std::vector<std::string>& prefixes,
                 std::map<int, SatRow>* rows, uint64_t* retrieved_ms, uint64_t* bytes, std::string* error) {
  constexpr uint32_t limit = 1000;
  std::set<int> ids;
  if (!discover_satcat(wanted, prefixes, &ids, error)) return false;
  std::map<int, int64_t> newest;
  for (int id : ids) {
  A::StorageQueryParams params{};
  sdm_piv::put(params.SCHEMA, "CAT.fbs");
  params.set_has_SCHEMA(true);
  params.LIMIT = limit;
  params.NORAD_CAT_ID = static_cast<uint32_t>(id);
  const auto response = sdm_piv::call("storage.query", "StorageQueryParams", params);
  if (!response.ok()) { *error = response.error_code() + ": " + response.error_message(); return false; }
  const auto [meta, count] = response.list<A::StoredRecordMeta>("records_meta");
  if (count >= limit) { *error = "CAT identity lookup reached its record limit; refusing incomplete source identities"; return false; }
  const std::string_view raw = response.raw("records");
  size_t at = 0;
  for (size_t i = 0; i < count; ++i) {
    if (at + 4 > raw.size()) { *error = "CAT record stream has a truncated length"; return false; }
    const uint32_t length = flatbuffers::ReadScalar<uint32_t>(reinterpret_cast<const uint8_t*>(raw.data() + at));
    at += 4;
    if (length > raw.size() - at || length != meta[i].LENGTH) { *error = "CAT record stream disagrees with its metadata"; return false; }
    const uint8_t* data = reinterpret_cast<const uint8_t*>(raw.data() + at);
    at += length;
    if (meta[i].SOURCE_NAME.str() != "celestrak-satcat-csv" || meta[i].PRODUCER_PEER_ID.str() != peer) continue;
    size_t size = length;
    if (size >= 12 && std::memcmp(data + 8, "$CAT", 4) == 0 && flatbuffers::ReadScalar<uint32_t>(data) == size - 4) { data += 4; size -= 4; }
    flatbuffers::Verifier verifier(data, size);
    if (!VerifyCATBuffer(verifier)) { *error = "stored SATCAT row is not a valid CAT record"; return false; }
    const auto* cat = GetCAT(data);
    SatRow r;
    r.norad = static_cast<int>(cat->NORAD_CAT_ID());
    r.name = cat->OBJECT_NAME() ? cat->OBJECT_NAME()->str() : std::string();
    if (r.norad != id) { *error = "CAT identity lookup returned the wrong NORAD number"; return false; }
    bool keep = wanted.count(r.norad) > 0;
    for (const auto& prefix : prefixes) if (r.name.compare(0, prefix.size(), prefix) == 0) keep = true;
    *retrieved_ms = std::max(*retrieved_ms, static_cast<uint64_t>(std::max<int64_t>(0, meta[i].TIMESTAMP_MS)));
    *bytes += length;
    if (!keep || r.norad <= 0) continue;
    r.object_id = cat->OBJECT_ID() ? cat->OBJECT_ID()->str() : std::string();
    r.type = cat->OBJECT_TYPE() == spaceObjectClass::PAYLOAD ? "PAY" : "OTHER";
    r.launch = cat->LAUNCH_DATE() ? cat->LAUNCH_DATE()->str() : std::string();
    r.decay = cat->DECAY_DATE() ? cat->DECAY_DATE()->str() : std::string();
    const auto old = rows->find(r.norad);
    if (old != rows->end() && newest[r.norad] == meta[i].TIMESTAMP_MS &&
        (old->second.name != r.name || old->second.object_id != r.object_id || old->second.type != r.type ||
         old->second.launch != r.launch || old->second.decay != r.decay)) {
      *error = "conflicting stored SATCAT identities for NORAD " + std::to_string(r.norad); return false;
    }
    if (old == rows->end() || newest[r.norad] < meta[i].TIMESTAMP_MS) {
      newest[r.norad] = meta[i].TIMESTAMP_MS;
      (*rows)[r.norad] = std::move(r);
    }
  }
  if (at != raw.size()) { *error = "CAT record stream has unaccounted bytes"; return false; }
  }
  return true;
}

// "11 Feb 2013" -> "2013-02-11"; empty when it is not that form.
std::string oscar_date(const std::string& s) {
  static const char* months[] = {"Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"};
  if (s.size() != 11 || s[2] != ' ' || s[6] != ' ') return std::string();
  int month = 0;
  for (int i = 0; i < 12; ++i) if (s.compare(3, 3, months[i]) == 0) month = i + 1;
  if (!month) return std::string();
  char out[16];
  std::snprintf(out, sizeof(out), "%s-%02d-%s", s.substr(7, 4).c_str(), month, s.substr(0, 2).c_str());
  return out;
}

// Two launch dates (YYYY-MM-DD) within a day of each other: OSCAR and the SATCAT reckon the day in different time zones.
bool same_launch_day(const std::string& a, const std::string& b) {
  if (a.size() != 10 || b.size() != 10) return false;
  auto days = [](const std::string& d) { return sdn_time::days_from_civil(std::atoi(d.substr(0, 4).c_str()), std::atoi(d.substr(5, 2).c_str()), std::atoi(d.substr(8, 2).c_str())); };
  const int64_t delta = days(a) - days(b);
  return delta >= -1 && delta <= 1;
}

// ---- An OSCAR instrument page.
struct Channel {
  std::string name;
  double low_hz = 0, high_hz = 0;
  bool derived = false;  // an edge is computed (unit conversion, or centre -/+ width / 2)
};

struct Page {
  std::string acronym, full_name, scanning, resolution, last_update, classification;
  SensorType type = SensorType::UNSPECIFIED;
  std::vector<Channel> channels;
  size_t rows_unread = 0;
  std::vector<std::string> unread;  // the centre cells of the rows not read
  bool has_table = false;
};

SensorType type_of_classification(const std::string& c) {
  if (c.find("Moderate resolution optical imager") != std::string::npos || c.find("High resolution optical imager") != std::string::npos) return SensorType::MULTISPECTRAL_IMAGER;
  if (c.find("Imaging radar (SAR)") != std::string::npos) return SensorType::SAR;
  if (c.find("Radar altimeter") != std::string::npos) return SensorType::ALTIMETER;
  if (c.find("Passive microwave radiometer") != std::string::npos) return SensorType::RADIOMETER;
  return SensorType::UNSPECIFIED;
}

snrEmissionMode emission_of(SensorType t) {
  switch (t) {
    case SensorType::RADAR_PULSE: case SensorType::RADAR_DOPPLER: case SensorType::RADAR_CW: case SensorType::RADAR_AESA: case SensorType::RADAR_PESA:
    case SensorType::LASER_DESIGNATOR: case SensorType::LASER_RANGEFINDER: case SensorType::SONAR_ACTIVE: case SensorType::SAR: case SensorType::ALTIMETER:
    case SensorType::SCATTEROMETER: case SensorType::LIDAR: case SensorType::PHASED_ARRAY_EARLY_WARNING:
      return snrEmissionMode::ACTIVE;
    case SensorType::IR_SEARCH: case SensorType::IR_IMAGING: case SensorType::EO_TV: case SensorType::EO_LLLTV: case SensorType::RWR: case SensorType::MAW:
    case SensorType::SONAR_PASSIVE: case SensorType::ACOUSTIC: case SensorType::OPTICAL_TELESCOPE: case SensorType::MULTISPECTRAL_IMAGER:
    case SensorType::HYPERSPECTRAL_IMAGER: case SensorType::RADIOMETER: case SensorType::PASSIVE_RF_ESM: case SensorType::SIGINT:
      return snrEmissionMode::PASSIVE;
    default:
      return snrEmissionMode::UNSPECIFIED;
  }
}

bool starts_with_digit_or_na(const std::string& s) { return !s.empty() && ((s[0] >= '0' && s[0] <= '9') || s.compare(0, 3, "N/A") == 0); }

// "433 - 453 nm" (hyphen, en dash) -> lo, hi and the unit text.
bool read_interval(const std::string& s, double* lo, double* hi, std::string* unit) {
  std::string rest;
  if (!T::read_number(s, lo, &rest)) return false;
  size_t i = 0;
  while (i < rest.size() && rest[i] == ' ') ++i;
  if (rest.compare(i, 1, "-") == 0) ++i;
  else if (rest.compare(i, 3, "\xE2\x80\x93") == 0) i += 3;
  else return false;
  std::string tail;
  if (!T::read_number(rest.substr(i), hi, &tail)) return false;
  *unit = T::collapse(tail);
  return true;
}

// The channel table: <div class="frequencytable"><table>... Header rows come first (until a row whose first cell starts
// with a digit or "N/A"); the columns are found by their header text.
void read_table(const std::string& html, Page* page) {
  const size_t at = html.find("class=\"frequencytable\"");
  if (at == std::string::npos) return;
  const size_t open = html.find("<table", at), close = open == std::string::npos ? open : html.find("</table>", open);
  if (close == std::string::npos) return;
  const std::string table = html.substr(open, close - open);
  std::vector<std::vector<std::string>> rows;
  for (size_t p = 0;;) {
    const size_t tr = table.find("<tr", p);
    if (tr == std::string::npos) break;
    const size_t tr_end = table.find("</tr>", tr);
    if (tr_end == std::string::npos) break;
    std::vector<std::string> cells;
    for (size_t q = tr; q < tr_end;) {
      const size_t td = table.find("<t", q);
      if (td == std::string::npos || td >= tr_end) break;
      if (table.compare(td, 3, "<td") != 0 && table.compare(td, 3, "<th") != 0) { q = td + 2; continue; }
      const size_t gt = table.find('>', td);
      const size_t end = table.find(table.compare(td, 3, "<td") == 0 ? "</td>" : "</th>", gt);
      if (gt == std::string::npos || end == std::string::npos || end > tr_end) break;
      cells.push_back(T::html_text(table.substr(gt + 1, end - gt - 1)));
      q = end + 5;
    }
    rows.push_back(cells);
    p = tr_end + 5;
  }
  size_t first = 0;
  while (first < rows.size() && !(rows[first].size() && starts_with_digit_or_na(rows[first][0]))) ++first;
  if (first == 0 || first >= rows.size()) return;
  std::vector<std::string> header(rows[0].size());
  for (size_t r = 0; r < first; ++r) for (size_t c = 0; c < rows[r].size() && c < header.size(); ++c) header[c] += (header[c].empty() ? "" : " ") + rows[r][c];
  int centre = -1, width = -1, interval = -1, number = -1;
  for (size_t c = 0; c < header.size(); ++c) {
    if (header[c].find("Central") != std::string::npos && centre < 0) centre = static_cast<int>(c);
    else if (header[c].find("Bandwidth") != std::string::npos && width < 0) width = static_cast<int>(c);
    else if (header[c].find("interval") != std::string::npos && interval < 0) interval = static_cast<int>(c);
    else if (header[c] == "No." && number < 0) number = static_cast<int>(c);
  }
  if (centre < 0 || (width < 0 && interval < 0 && header[centre].find("(") == std::string::npos && rows[first][centre].find("m") == std::string::npos)) return;
  page->has_table = true;
  auto header_unit = [&](int c) {
    if (c < 0) return std::string();
    const size_t a = header[c].find('('), b = header[c].find(')');
    return a != std::string::npos && b != std::string::npos && b > a ? header[c].substr(a + 1, b - a - 1) : std::string();
  };
  const std::string centre_unit = header_unit(centre), width_unit = header_unit(width);
  for (size_t r = first; r < rows.size(); ++r) {
    const auto& cells = rows[r];
    if (cells.size() <= static_cast<size_t>(centre)) { ++page->rows_unread; continue; }
    Channel ch;
    ch.name = number >= 0 && static_cast<size_t>(number) < cells.size() ? "channel " + cells[number] : cells[centre];
    // The unit of a cell is its own, else the column header's. A frequency column is Hz-scaled, a wavelength column metres-scaled.
    auto value = [&](const std::string& cell, const std::string& header_unit_text, double* v, bool* is_freq) {
      std::string rest;
      if (!T::read_number(cell, v, &rest)) return false;
      std::string unit = T::collapse(rest);
      unit = unit.substr(0, unit.find(' '));  // "um (fire)": the unit is the first word, the qualifier stays in the name
      if (unit.empty()) unit = header_unit_text;
      if (const double f = T::frequency_scale(unit)) { *v *= f; *is_freq = true; return true; }
      if (const double w = T::wavelength_scale(unit)) { *v *= w; *is_freq = false; return true; }
      return false;
    };
    double c0 = 0, w0 = 0, lo = 0, hi = 0;
    bool c_freq = false, w_freq = false, have_c = value(cells[centre], centre_unit, &c0, &c_freq), have_w = false;
    if (width >= 0 && static_cast<size_t>(width) < cells.size()) have_w = value(cells[width], width_unit, &w0, &w_freq);
    bool have_i = false, i_freq = false;
    // The interval is its own column, or a "Bandwidth" cell that states a range ("0.60-0.68 um").
    for (int column : {interval, width}) {
      if (have_i || column < 0 || static_cast<size_t>(column) >= cells.size()) continue;
      std::string unit;
      if (!read_interval(cells[column], &lo, &hi, &unit)) continue;
      unit = unit.substr(0, unit.find(' '));
      if (const double w = T::wavelength_scale(unit)) { lo *= w; hi *= w; have_i = true; i_freq = false; }
      else if (const double f = T::frequency_scale(unit)) { lo *= f; hi *= f; have_i = true; i_freq = true; }
    }
    if (have_i) {
      ch.low_hz = i_freq ? lo : kC / hi;
      ch.high_hz = i_freq ? hi : kC / lo;
      ch.derived = !i_freq;
    } else if (have_c && have_w && c_freq == w_freq) {
      if (c_freq) { ch.low_hz = c0 - w0 / 2; ch.high_hz = c0 + w0 / 2; }
      else { ch.low_hz = kC / (c0 + w0 / 2); ch.high_hz = kC / (c0 - w0 / 2); }
      ch.derived = true;
      if (!(ch.low_hz > 0 && ch.high_hz >= ch.low_hz)) { ++page->rows_unread; page->unread.push_back(ch.name); continue; }
    } else if (have_c) {
      ch.low_hz = ch.high_hz = c_freq ? c0 : kC / c0;
      ch.derived = !c_freq;
    } else { ++page->rows_unread; page->unread.push_back(ch.name); continue; }
    page->channels.push_back(ch);
  }
}

void read_page(const std::string& html, const std::string& text, Page* page) {
  page->acronym = T::between(text, "Acronym ", " Full name ");
  page->full_name = T::between(text, " Full name ", " Purpose ");
  page->scanning = T::between(text, " Scanning Technique ", " Resolution ");
  page->resolution = T::between(text, " Scanning Technique ", " Coverage / Cycle ");
  const size_t r = page->resolution.find(" Resolution ");
  page->resolution = r == std::string::npos ? std::string() : T::collapse(page->resolution.substr(r + 12));
  const size_t lu = text.find("Last update: ");
  if (lu != std::string::npos) page->last_update = text.substr(lu + 13, 10);
  page->classification = T::between(text, "Instrument classification ", " WIGOS Subcomponents");
  page->type = type_of_classification(page->classification);
  read_table(html, page);
}

// ---- A MediaWiki extract: {"query":{"pages":{"<id>":{"title","extract","revisions":[{"revid","timestamp"}]}}}}
struct Wiki { std::string title, extract, revid, timestamp; };
bool read_wiki(const std::string& body, Wiki* w) {
  const Json j = Json::parse(body, nullptr, false);
  if (j.is_discarded() || !j.contains("query") || !j["query"].contains("pages") || !j["query"]["pages"].is_object() || j["query"]["pages"].size() != 1) return false;
  const Json& page = j["query"]["pages"].begin().value();
  if (!page.is_object() || !page.contains("extract") || !page["extract"].is_string() || !page.contains("revisions") || !page["revisions"].is_array() || page["revisions"].empty()) return false;
  w->title = page.value("title", std::string());
  w->extract = T::collapse(page["extract"].get<std::string>());
  w->revid = std::to_string(page["revisions"][0].value("revid", 0LL));
  w->timestamp = page["revisions"][0].value("timestamp", std::string());
  return !w->extract.empty() && w->revid != "0";
}

// ---- Facts: a value is published only when its quote is in the document and its number is in the quote.
struct Verified {
  double value = 0;
  std::string quote;
};
bool verify(const roster::Fact& f, const std::string& text, Verified* out) {
  const std::string quote = T::collapse(f.quote);
  if (text.find(quote) == std::string::npos) return false;
  out->quote = quote;
  if (!f.number) { out->value = f.literal; return true; }
  const std::string number = f.number;
  if (quote.find(number) == std::string::npos) return false;
  double v = 0;
  if (!T::read_number(number, &v, nullptr)) return false;
  out->value = v * f.scale;
  return true;
}

constexpr double nan() { return std::numeric_limits<double>::quiet_NaN(); }

// Everything the roster's facts give one sensor.
struct Spec {
  SensorType type = SensorType::UNSPECIFIED;
  snrEmissionMode emission = snrEmissionMode::UNSPECIFIED;
  std::vector<Channel> bands;
  std::vector<std::string> designations;
  double rf_bandwidth = 0, rf_power = 0, look_inner = 0, look_outer = 0, cone = 0, max_range = 0, boresight_az = nan(), boresight_el = nan(), el_min = nan(), aperture = 0;
  bool has_look_inner = false, has_look_outer = false, has_cone = false, fixed = false;
  std::vector<std::string> quotes;  // the verified quotes, in order, without repeats
  size_t verified = 0, refused = 0;
  std::vector<std::string> refusals;
};

void keep_quote(Spec* s, const std::string& q) { if (std::find(s->quotes.begin(), s->quotes.end(), q) == s->quotes.end()) s->quotes.push_back(q); }

void apply_facts(const roster::BandSpec* bands, size_t band_count, const roster::Fact* facts, size_t fact_count, const std::string& text, Spec* s) {
  struct Edge { double low = 0, high = 0, centre = 0, width = 0; };
  std::vector<Edge> edges(band_count);
  std::vector<bool> derived(band_count, false);
  for (size_t i = 0; i < band_count; ++i) {
    Channel ch;
    ch.name = bands[i].name;
    s->bands.push_back(ch);
    std::string d;
    if (bands[i].designation && bands[i].designation_quote) {
      const std::string quote = T::collapse(bands[i].designation_quote);
      if (text.find(quote) != std::string::npos && quote.find(bands[i].designation) != std::string::npos) { d = bands[i].designation; keep_quote(s, quote); ++s->verified; }
      else { ++s->refused; s->refusals.push_back(std::string("designation ") + bands[i].designation + ": " + bands[i].designation_quote); }
    }
    s->designations.push_back(d);
  }
  for (size_t i = 0; i < fact_count; ++i) {
    const roster::Fact& f = facts[i];
    Verified v;
    if (!verify(f, text, &v)) { ++s->refused; s->refusals.push_back(std::string(f.quote)); continue; }
    ++s->verified;
    keep_quote(s, v.quote);
    const size_t b = static_cast<size_t>(f.band);
    switch (f.field) {
      case roster::Field::BandLowHz: if (b < band_count) edges[b].low = v.value; break;
      case roster::Field::BandHighHz: if (b < band_count) edges[b].high = v.value; break;
      case roster::Field::BandCenterHz: if (b < band_count) edges[b].centre = v.value; break;
      case roster::Field::BandWidthHz: if (b < band_count) edges[b].width = v.value; break;
      case roster::Field::RfBandwidthHz: s->rf_bandwidth = v.value; break;
      case roster::Field::RfPeakPowerW: s->rf_power = v.value; break;
      case roster::Field::LookInnerDeg: s->look_inner = v.value; s->has_look_inner = true; break;
      case roster::Field::LookOuterDeg: s->look_outer = v.value; s->has_look_outer = true; break;
      case roster::Field::ConeHalfAngleDeg: s->cone = v.value; s->has_cone = true; break;
      case roster::Field::MaxRangeM: s->max_range = v.value; break;
      case roster::Field::BoresightAzDeg: s->boresight_az = v.value; break;
      case roster::Field::BoresightElDeg: s->boresight_el = v.value; break;
      case roster::Field::ElLimitMinDeg: s->el_min = v.value; break;
      case roster::Field::PointingFixed: s->fixed = true; break;
      case roster::Field::ApertureM: s->aperture = v.value; break;
      case roster::Field::Type: s->type = static_cast<SensorType>(static_cast<int>(v.value)); break;
      case roster::Field::Emission: s->emission = static_cast<snrEmissionMode>(static_cast<int>(v.value)); break;
    }
  }
  for (size_t i = 0; i < band_count; ++i) {
    Channel& ch = s->bands[i];
    const Edge& e = edges[i];
    if (e.low > 0 && e.high >= e.low) { ch.low_hz = e.low; ch.high_hz = e.high; }
    else if (e.centre > 0 && e.width > 0) { ch.low_hz = e.centre - e.width / 2; ch.high_hz = e.centre + e.width / 2; ch.derived = true; }
    else if (e.centre > 0) ch.low_hz = ch.high_hz = e.centre;
    (void)derived;
  }
}

// ---- Records.
using Provenance = std::unique_ptr<OPPProvenanceT>;

Provenance provenance(const std::string& source, const std::string& record_id, const std::string& url, const Doc& doc, const std::string& version, const char* license,
                      const char* attribution, const std::string& notes) {
  auto p = std::make_unique<OPPProvenanceT>();
  p->SOURCE = source;
  p->SOURCE_RECORD_ID = record_id;
  p->SOURCE_URL = url;
  p->RETRIEVED_AT = rfc3339_ms(doc.retrieved_ms);
  p->SOURCE_VERSION = version;
  p->METHOD = oppDeterminationMethod::UNSPECIFIED;  // the source publishes the value without stating how it was obtained
  p->LICENSE = license;
  p->ATTRIBUTION = attribution;
  p->SOURCE_SHA256 = doc.sha256;
  p->NOTES = notes;
  return p;
}

std::string clip(const std::string& s, size_t n) { return s.size() <= n ? s : s.substr(0, n) + "..."; }

struct Built {
  std::vector<uint8_t> bytes;  // one size-prefixed $SNR
  SensorType type = SensorType::UNSPECIFIED;
  size_t bands = 0;
};

// One sensor to one size-prefixed $SNR. `fixed_mount` says a boresight or pointing fact exists.
bool build_snr(SNRT& s, const Spec& spec, std::string* error, Built* out) {
  s.TYPE = spec.type;
  s.EMISSION = spec.emission != snrEmissionMode::UNSPECIFIED ? spec.emission : emission_of(spec.type);
  const snrBandDirection direction = s.EMISSION == snrEmissionMode::PASSIVE ? snrBandDirection::RECEIVE : snrBandDirection::UNSPECIFIED;
  for (size_t i = 0; i < spec.bands.size(); ++i) {
    auto b = std::make_unique<SNRSpectralBandT>();
    b->NAME = spec.bands[i].name;
    if (i < spec.designations.size()) b->DESIGNATION = spec.designations[i];
    b->FREQ_LOW_HZ = spec.bands[i].low_hz;
    b->FREQ_HIGH_HZ = spec.bands[i].high_hz;
    b->DIRECTION = direction;
    s.SPECTRAL_BANDS.push_back(std::move(b));
  }
  const bool sar_fov = spec.type == SensorType::SAR && spec.has_look_inner && spec.has_look_outer;
  if (spec.has_cone || sar_fov) {
    auto fov = std::make_unique<SCVSensorShapeContractT>();
    if (sar_fov) {
      fov->SHAPE_KIND = scvSensorShapeKind::SAR_ANNULAR_SECTOR;
      fov->INNER_LOOK_ANGLE_DEG = spec.look_inner;
      fov->OUTER_LOOK_ANGLE_DEG = spec.look_outer;
    } else {
      fov->SHAPE_KIND = scvSensorShapeKind::CONIC;
      fov->OUTER_HALF_ANGLE_DEG = spec.cone;
    }
    fov->MAX_RANGE_M = spec.max_range;
    s.FIELD_OF_VIEW = std::move(fov);
  }
  if (!std::isnan(spec.boresight_az) || !std::isnan(spec.boresight_el) || !std::isnan(spec.el_min) || spec.fixed) {
    auto m = std::make_unique<SNRMountingT>();
    m->FRAME = snrMountingFrame::LOCAL_ENU;
    m->BORESIGHT_AZIMUTH_DEG = spec.boresight_az;
    m->BORESIGHT_ELEVATION_DEG = spec.boresight_el;
    m->ELEVATION_LIMIT_MIN_DEG = spec.el_min;
    if (spec.fixed) m->POINTING = snrPointingMode::FIXED;
    s.MOUNTING = std::move(m);
  }
  if (spec.rf_bandwidth > 0 || spec.rf_power > 0) {
    auto rf = std::make_unique<SNRRfParametersT>();
    rf->PEAK_POWER_W = spec.rf_power;
    rf->BANDWIDTH_HZ = spec.rf_bandwidth;
    s.RF = std::move(rf);
  }
  if (spec.aperture > 0) {
    auto o = std::make_unique<SNROpticalParametersT>();
    o->APERTURE_M = spec.aperture;
    s.OPTICAL = std::move(o);
  }
  flatbuffers::FlatBufferBuilder b(2048);
  FinishSizePrefixedSNRBuffer(b, SNR::Pack(b, &s));
  if (b.GetSize() > kMaxRecordBytes) return *error = s.SENSOR_ID + " is " + std::to_string(b.GetSize()) + " bytes, over the 8 KiB record bound", false;
  out->bytes.assign(b.GetBufferPointer(), b.GetBufferPointer() + b.GetSize());
  out->type = s.TYPE;
  out->bands = s.SPECTRAL_BANDS.size();
  return true;
}

struct Lane {
  std::vector<uint8_t> stream;
  size_t count = 0, bands = 0;
  std::map<std::string, size_t> by_type;
  std::vector<std::pair<std::string, std::string>> attributes;
  uint64_t retrieved_ms = 0;
};

void add(Lane* lane, const Built& b, const std::string& id, const std::string& label, uint64_t retrieved_ms) {
  lane->stream.insert(lane->stream.end(), b.bytes.begin(), b.bytes.end());
  ++lane->count;
  lane->bands += b.bands;
  ++lane->by_type[EnumNameSensorType(b.type)];
  lane->attributes.push_back({id, label});
  lane->retrieved_ms = std::max(lane->retrieved_ms, retrieved_ms);
}

int push_meta(const char* port, const char* source_name, const Lane& lane, const std::string& peer, const char* license, const char* license_url, bool share_alike, const std::string& citation, const std::string& source_url) {
  const std::string sha = ephem::sha256_hex(lane.stream.data(), lane.stream.size());
  R::IngestRequestT m;
  m.SCHEMA = "SNR.fbs";
  m.RECONCILE = R::reconcileMode_Current;
  m.TAGS = std::make_unique<R::SourceTagsT>();
  auto& tags = *m.TAGS;
  tags.PROVIDER_ID = kProvider;
  tags.SOURCE_NAME = source_name;
  tags.BATCH_ID = sha;
  tags.SOURCE_URL = source_url;
  tags.SOURCE_PEER = peer;
  tags.LICENSE = license;
  tags.LICENSE_URL = license_url;
  tags.SHARE_ALIKE = share_alike;
  tags.CITATION = citation;
  m.PROVENANCE = std::make_unique<R::ProvenanceT>();
  auto& p = *m.PROVENANCE;
  p.SOURCE_URL = source_url;
  p.HTTP_STATUS = 200;
  p.RETRIEVED_MS = lane.retrieved_ms;
  p.PARSER = kProvider;
  p.PARSER_VERSION = kVersion;
  p.NORMALIZED_SHA256 = sha;
  p.NORMALIZED_COUNT = lane.count;
  p.SCHEMAS = {"SNR"};
  p.SCHEMA_COUNTS = {lane.count};
  for (const auto& entry : lane.attributes) {
    auto a = std::make_unique<R::HeaderT>();
    a->NAME = entry.first;
    a->VALUE = entry.second;
    p.ATTRIBUTES.push_back(std::move(a));
  }
  flatbuffers::FlatBufferBuilder b(4096);
  R::FinishIngestRequestBuffer(b, R::IngestRequest::Pack(b, &m));
  return push(port, "IngestRequest.fbs", "INGQ", "IngestRequest", b.GetBufferPointer(), b.GetSize());
}

int push_notice(R::flowNoticeKind kind, const char* reason, uint64_t count, const std::vector<std::string>& items, uint64_t at) {
  R::FlowNoticeT n;
  n.KIND = kind;
  n.SCHEMA = "SNR.fbs";
  n.PROVIDER_ID = kProvider;
  n.SOURCE_NAME = kProvider;
  n.REASON = reason;
  n.COUNT = count;
  n.ITEMS = items;
  n.AT_MS = at;
  flatbuffers::FlatBufferBuilder b(2048);
  R::FinishFlowNoticeBuffer(b, R::FlowNotice::Pack(b, &n));
  return push("notice", "FlowNotice.fbs", "FNTC", "FlowNotice", b.GetBufferPointer(), b.GetSize());
}

int push_pvn(const char* source_id, const char* originator, const char* host_url, pvnLicenseClass klass, const char* license_id, const std::string& version, uint64_t retrieved_ms, uint64_t bytes) {
  PVNT p;
  p.SOURCE_ID = source_id;
  p.SOURCE_KIND = pvnSourceKind::Reference;
  p.ORIGINATOR = originator;
  p.PROVIDER_ID = kProvider;
  p.PRODUCER = std::string(kPluginId) + " " + kVersion;
  p.LICENSE_CLASS = klass;
  p.LICENSE_ID = license_id;
  p.LINEAGE = source_id;
  p.SOURCE_URL = host_url;
  p.SOURCE_VERSION = version;
  p.RETRIEVED_AT = rfc3339_ms(retrieved_ms);
  p.SOURCE_BYTES = bytes;
  flatbuffers::FlatBufferBuilder b(512);
  FinishPVNBuffer(b, CreatePVN(b, &p));
  return push("provenance", "PVN.fbs", "$PVN", "PVN", b.GetBufferPointer(), b.GetSize());
}

std::string oscar_instrument_url(const std::string& slug) { return kOscarInstrument + slug; }
std::string oscar_satellite_url(const std::string& slug) { return kOscarSatellite + slug; }
std::string wiki_url(const std::string& title) { return kWikiApi + url_encode(title); }

const roster::Instrument* instrument_of(const std::string& slug) {
  for (const auto& i : roster::kInstruments) if (slug == i.slug) return &i;
  return nullptr;
}

}  // namespace

extern "C" int plan_sources(void) {
  const auto ticks = frames("tick");
  if (ticks.size() != 1 || !ticks[0]->payload) return fail("missing-tick", "plan_sources requires one TimerTick on 'tick'.");
  flatbuffers::Verifier verifier(ticks[0]->payload, ticks[0]->payload_length);
  if (!R::VerifyTimerTickBuffer(verifier)) return fail("invalid-tick", "The tick frame is not a TimerTick (TICK).");
  std::vector<std::string> urls;
  std::set<std::string> seen(urls.begin(), urls.end());
  auto want = [&](const std::string& u) { if (seen.insert(u).second) urls.push_back(u); };
  for (const auto& p : roster::kPlatforms) want(oscar_satellite_url(p.oscar));
  for (const auto& p : roster::kPlatforms) for (const char* slug : p.instruments) if (slug) want(oscar_instrument_url(slug));
  for (const auto& g : roster::kGround) want(wiki_url(g.page));
  if (urls.size() > kMaxResponses) return fail("too-many-requests", "The roster plans more than 300 requests.");
  for (const auto& url : urls) {
    R::HttpRequestT request;
    request.METHOD = "GET";
    request.URL = url;
    request.TIMEOUT_MS = 60000;
    request.MAX_BYTES = 8u * 1024u * 1024u;
    sdn_source_http::identify(request);
    flatbuffers::FlatBufferBuilder b(512 + url.size());
    R::FinishHttpRequestBuffer(b, R::HttpRequest::Pack(b, &request));
    if (push("request", "HttpRequest.fbs", "HREQ", "HttpRequest", b.GetBufferPointer(), b.GetSize()) < 0) return fail("output-failed", "A request could not be written.");
  }
  return 0;
}

extern "C" int build_sensors(void) {
  const auto host_config = sdm_piv::get_config();
  if (!host_config.ok()) return fail("invalid-config", "The node configuration could not be read.");
  if (host_config.kind("producer_peer_id") != R::configValueKind_String || host_config.string("producer_peer_id").empty()) return fail("missing-producer-peer-id", "producer_peer_id (String) is required.");
  const std::string peer(host_config.string("producer_peer_id"));

  // The responses, by URL.
  std::map<std::string, Doc> docs;
  std::vector<std::string> missing;
  const auto inputs = frames("response");
  if (inputs.empty() || inputs.size() > kMaxResponses) return fail("invalid-responses", "build_sensors takes 1 to 300 HttpResponse frames on 'response'.");
  for (const auto* f : inputs) {
    if (!f->payload || f->payload_length < 8) return fail("invalid-http-response", "An empty response frame.");
    flatbuffers::Verifier v(f->payload, f->payload_length, 64, 1000000, false);
    if (!R::VerifyHttpResponseBuffer(v)) return fail("invalid-http-response", "A response frame is not an HttpResponse (HRSP).");
    const auto* r = R::GetHttpResponse(f->payload);
    const std::string url = r->URL() ? r->URL()->str() : std::string();
    Doc d;
    d.retrieved_ms = r->RETRIEVED_MS();
    if (r->ERROR() && r->ERROR()->size()) d.error = "transport: " + r->ERROR()->str();
    else if (r->STATUS() != 200) d.error = "HTTP " + std::to_string(r->STATUS());
    else if (!r->BODY() || r->BODY()->size() == 0 || r->BODY()->size() > kMaxBody) d.error = "empty or oversize body";
    else {
      d.ok = true;
      d.body.assign(reinterpret_cast<const char*>(r->BODY()->data()), r->BODY()->size());
      d.sha256 = ephem::sha256_hex(r->BODY()->data(), r->BODY()->size());
    }
    docs[url] = std::move(d);
  }
  auto doc = [&](const std::string& url, const char* what) -> const Doc* {
    const auto it = docs.find(url);
    if (it == docs.end()) { missing.push_back(std::string(what) + " not fetched: " + url); return nullptr; }
    if (!it->second.ok) { missing.push_back(std::string(what) + " " + it->second.error + ": " + url); return nullptr; }
    return &it->second;
  };

  // SATCAT rows the roster names.
  std::set<int> wanted;
  std::vector<std::string> prefixes;
  for (const auto& p : roster::kPlatforms) { if (p.norad) wanted.insert(p.norad); if (p.prefix) prefixes.push_back(p.prefix); }
  std::map<int, SatRow> satcat;
  uint64_t satcat_retrieved_ms = 0, satcat_bytes = 0;
  std::string satcat_error;
  if (!read_satcat(peer, wanted, prefixes, &satcat, &satcat_retrieved_ms, &satcat_bytes, &satcat_error))
    return fail("stored-satcat-failed", satcat_error);
  if (satcat.empty()) missing.push_back("No stored CAT identities from this producer's celestrak-satcat-csv lane");

  Lane space, ground;
  std::map<std::string, std::unique_ptr<Page>> pages;  // by instrument slug; nullptr: unreadable
  std::map<std::string, std::unique_ptr<Spec>> specs;
  std::map<std::string, std::string> page_text;
  uint64_t oscar_latest = 0, wiki_latest = 0, oscar_bytes = 0, wiki_bytes = 0;
  size_t satellites_read = 0, instruments_read = 0, claims_verified = 0, claims_refused = 0, rows_unread = 0, refused_platforms = 0;
  std::string oscar_version, wiki_version;

  auto page_of = [&](const std::string& slug) -> Page* {
    const auto it = pages.find(slug);
    if (it != pages.end()) return it->second.get();
    const std::string url = oscar_instrument_url(slug);
    const Doc* d = doc(url, "OSCAR instrument");
    if (!d) { pages[slug] = nullptr; return nullptr; }
    auto page = std::make_unique<Page>();
    const std::string text = T::html_text(d->body);
    read_page(d->body, text, page.get());
    page_text[slug] = text;
    if (page->acronym.empty() || page->type == SensorType::UNSPECIFIED) {
      missing.push_back("OSCAR instrument " + slug + " has no readable acronym or a classification the module does not map (" + clip(page->classification, 120) + ")");
      pages[slug] = nullptr;
      return nullptr;
    }
    ++instruments_read;
    oscar_latest = std::max(oscar_latest, d->retrieved_ms);
    oscar_bytes += d->body.size();
    rows_unread += page->rows_unread;
    return (pages[slug] = std::move(page)).get();
  };

  for (const auto& platform : roster::kPlatforms) {
    const Doc* sat_doc = doc(oscar_satellite_url(platform.oscar), "OSCAR satellite");
    if (!sat_doc || satcat.empty()) { ++refused_platforms; continue; }
    const Json sj = Json::parse(sat_doc->body, nullptr, false);
    if (sj.is_discarded() || !sj.contains("satellite") || !sj["satellite"].is_array() || sj["satellite"].size() != 1) {
      missing.push_back(std::string("OSCAR satellite ") + platform.oscar + " is not a satellite document");
      ++refused_platforms;
      continue;
    }
    const Json& sat = sj["satellite"][0];
    const std::string launch = oscar_date(sat.value("launch_date", std::string()));
    std::map<std::string, std::string> instrument_status;  // slug -> OSCAR status on this satellite
    for (const auto& si : sat.value("satellite-instruments", Json::array())) {
      if (si.contains("instrument") && si["instrument"].contains("slug")) instrument_status[si["instrument"]["slug"].get<std::string>()] = si.value("status", std::string());
    }
    // The members: one SATCAT row for a satellite (its launch date must equal OSCAR's), the on-orbit payloads of a constellation.
    std::vector<const SatRow*> members;
    if (platform.norad) {
      const auto it = satcat.find(platform.norad);
      if (it == satcat.end()) { missing.push_back(std::string("NORAD ") + std::to_string(platform.norad) + " (" + platform.oscar + ") is not in the SATCAT"); ++refused_platforms; continue; }
      if (!same_launch_day(launch, it->second.launch)) {
        missing.push_back(std::string("NORAD ") + std::to_string(platform.norad) + " (" + platform.oscar + "): SATCAT launch " + it->second.launch + " is not within a day of OSCAR's " + sat.value("launch_date", std::string("(none)")));
        ++refused_platforms;
        continue;
      }
      members.push_back(&it->second);
    } else {
      for (const auto& entry : satcat) {
        const SatRow& r = entry.second;
        if (r.name.compare(0, std::strlen(platform.prefix), platform.prefix) == 0 && r.type == "PAY" && r.decay.empty()) members.push_back(&r);
      }
    }
    if (members.empty()) { missing.push_back(std::string("no SATCAT member for ") + platform.oscar); ++refused_platforms; continue; }
    ++satellites_read;
    oscar_latest = std::max(oscar_latest, sat_doc->retrieved_ms);
    oscar_bytes += sat_doc->body.size();

    for (const char* slug_c : platform.instruments) {
      if (!slug_c) continue;
      const std::string slug = slug_c;
      if (!instrument_status.count(slug)) { missing.push_back(std::string("OSCAR does not list ") + slug + " on " + platform.oscar); continue; }
      const roster::Instrument* inst = instrument_of(slug);
      if (!inst) { missing.push_back("instrument " + slug + " is not in the roster"); continue; }
      Page* page = page_of(slug);
      if (!page) continue;
      // The instrument's spec is the same on every platform that carries it.
      Spec* spec = nullptr;
      const auto sit = specs.find(slug);
      if (sit != specs.end()) spec = sit->second.get();
      else {
        auto s = std::make_unique<Spec>();
        s->type = page->type;
        if (inst->bands) apply_facts(inst->bands, inst->band_count, inst->facts, inst->fact_count, page_text[slug], s.get());
        else s->bands = page->channels;
        if (inst->bands && s->bands.empty()) { missing.push_back("OSCAR instrument " + slug + " gave no band"); }
        claims_verified += s->verified;
        claims_refused += s->refused;
        for (const auto& r : s->refusals) missing.push_back("OSCAR " + slug + ": quote not found: " + clip(r, 100));
        spec = (specs[slug] = std::move(s)).get();
        // An instrument with neither a table band nor a verified band is not a spectral sensor: it is published without bands only when it states a field of view.
      }
      if (spec->bands.empty() && !spec->has_look_inner) { missing.push_back("OSCAR instrument " + slug + " has nothing publishable"); continue; }
      const Doc* page_doc = doc(oscar_instrument_url(slug), "OSCAR instrument");
      for (const SatRow* member : members) {
        SNRT s;
        s.SENSOR_ID = "oscar:" + slug + ":" + std::to_string(member->norad);
        s.NAME = page->acronym + " on " + member->name;
        s.NORAD_CAT_ID = static_cast<uint32_t>(member->norad);
        s.OBJECT_ID = member->object_id;
        std::string notes = page->full_name + ".";
        if (!page->scanning.empty()) notes += " Scanning: " + clip(page->scanning, 400) + ".";
        if (!page->resolution.empty()) notes += " Resolution: " + clip(page->resolution, 300) + ".";
        notes += " OSCAR status on " + std::string(platform.oscar) + ": " + instrument_status[slug] + ".";
        notes += " NORAD_CAT_ID and OBJECT_ID are the CelesTrak SATCAT row of " + member->name + (platform.norad ? ", matched to OSCAR by the launch date " + member->launch + " (OSCAR: " + sat.value("launch_date", std::string()) + ")" : std::string(", a SATCAT payload named ") + platform.prefix + "* still in orbit") + ".";
        if (!page->unread.empty()) {
          notes += " Channels not read, because the page gives their centre as an offset or a formula and not as one number:";
          for (const auto& u : page->unread) notes += " [" + u + "]";
          notes += ".";
        }
        bool derived = false;
        for (const auto& ch : spec->bands) derived = derived || ch.derived;
        if (derived) notes += " Band edges are derived: a stated wavelength interval is converted with f = c/lambda (c = 299792458 m/s); a centre and a bandwidth give centre -/+ bandwidth/2.";
        if (!spec->quotes.empty()) {
          notes += " Read from the page:";
          for (const auto& q : spec->quotes) notes += " \"" + q + "\"";
        }
        s.NOTES = clip(notes, 2800);
        s.PROVENANCE = provenance("WMO OSCAR/Space", platform.oscar + std::string("/") + slug, oscar_instrument_url(slug), *page_doc, page->last_update, kOscarLicense, kOscarAttribution,
                                  "Instrument page last update " + page->last_update + "; satellite document " + oscar_satellite_url(platform.oscar));
        Built built;
        std::string error;
        if (!build_snr(s, *spec, &error, &built)) { missing.push_back(error); continue; }
        add(&space, built, s.SENSOR_ID, s.NAME, page_doc->retrieved_ms);
      }
    }
  }

  // Ground sensors: a MediaWiki extract, the facts verified against its text.
  size_t pages_read = 0;
  std::set<std::string> wiki_seen;
  for (const auto& g : roster::kGround) {
    const std::string url = wiki_url(g.page);
    const Doc* d = doc(url, "Wikipedia");
    if (!d) continue;
    Wiki w;
    if (!read_wiki(d->body, &w)) { missing.push_back(std::string("Wikipedia ") + g.page + " is not a readable extract"); continue; }
    if (wiki_seen.insert(url).second) { ++pages_read; wiki_latest = std::max(wiki_latest, d->retrieved_ms); wiki_bytes += d->body.size(); wiki_version = w.timestamp; }
    Spec spec;
    apply_facts(g.bands, g.band_count, g.facts, g.fact_count, w.extract, &spec);
    claims_verified += spec.verified;
    claims_refused += spec.refused;
    for (const auto& r : spec.refusals) missing.push_back(std::string("Wikipedia ") + g.page + ": quote not found: " + clip(r, 100));
    SNRT s;
    s.SENSOR_ID = std::string("ground:") + g.site_id + ":" + g.id;
    s.NAME = g.name;
    s.SITE_ID = g.site_id;
    bool derived = false;
    for (const auto& ch : spec.bands) derived = derived || ch.derived;
    std::string notes = std::string("Wikipedia \"") + w.title + "\" revision " + w.revid + " (" + w.timestamp + "). Facts quoted from the page:";
    for (const auto& q : spec.quotes) notes += " \"" + q + "\"";
    notes += ".";
    if (derived) notes += " Band edges are derived: the centre frequency -/+ half the stated bandwidth.";
    if (spec.type == SensorType::UNSPECIFIED) notes += " The page does not classify the sensor into a SensorType.";
    notes += " SITE_ID is the ID of the site's record in the target-models SIT collection (data/sit_collection.json).";
    s.NOTES = clip(notes, 3500);
    s.PROVENANCE = provenance("Wikipedia", w.title + "@" + w.revid, std::string("https://en.wikipedia.org/w/index.php?oldid=") + w.revid, *d, w.revid, kWikiLicense,
                              (std::string("Wikipedia contributors, \"") + w.title + "\", Wikipedia, the free encyclopedia, revision " + w.revid + ", CC BY-SA 4.0").c_str(), "Facts verified against the revision's plain text by quote.");
    Built built;
    std::string error;
    if (!build_snr(s, spec, &error, &built)) { missing.push_back(error); continue; }
    add(&ground, built, s.SENSOR_ID, s.NAME, d->retrieved_ms);
  }

  // Outputs.
  if (space.count && (push("space_records", "SNR.fbs", "$SNR", "SNR", space.stream.data(), space.stream.size()) < 0 ||
                      push_meta("space_meta", "space", space, peer, "LicenseRef-WMO-OSCAR-Space-Disclaimer AND LicenseRef-CelesTrak-SATCAT", "https://space.oscar.wmo.int/pages/disclaimer", false,
                               "Sensors: WMO OSCAR/Space (World Meteorological Organization); platforms: CelesTrak SATCAT", "https://space.oscar.wmo.int/") < 0))
    return fail("output-failed", "The space lane could not be written.");
  if (ground.count && (push("ground_records", "SNR.fbs", "$SNR", "SNR", ground.stream.data(), ground.stream.size()) < 0 ||
                       push_meta("ground_meta", "ground", ground, peer, kWikiLicense, "https://creativecommons.org/licenses/by-sa/4.0/", true, "Wikipedia contributors, Wikipedia, the free encyclopedia (CC BY-SA 4.0)", "https://en.wikipedia.org/") < 0))
    return fail("output-failed", "The ground lane could not be written.");
  if (space.count && (push_pvn("wmo-oscar-space", "WMO", "https://space.oscar.wmo.int/", pvnLicenseClass::Reproducible, "wmo-oscar-space-disclaimer", oscar_version, oscar_latest, oscar_bytes) < 0 ||
                      push_pvn("celestrak-satcat", "CelesTrak", kSatcatUrl, pvnLicenseClass::Reproducible, "celestrak-satcat", "", satcat_retrieved_ms, satcat_bytes) < 0))
    return fail("output-failed", "A provenance record could not be written.");
  if (ground.count && push_pvn("wikipedia-extracts", "Wikipedia contributors", "https://en.wikipedia.org/", pvnLicenseClass::ShareAlike, "CC-BY-SA-4.0", wiki_version, wiki_latest, wiki_bytes) < 0)
    return fail("output-failed", "A provenance record could not be written.");

  std::vector<std::string> items = {"records.space=" + std::to_string(space.count), "records.ground=" + std::to_string(ground.count),
                                    "bands.space=" + std::to_string(space.bands), "bands.ground=" + std::to_string(ground.bands),
                                    "oscar.satellites=" + std::to_string(satellites_read), "oscar.instruments=" + std::to_string(instruments_read),
                                    "oscar.rowsUnread=" + std::to_string(rows_unread), "wikipedia.pages=" + std::to_string(pages_read),
                                    "claims.verified=" + std::to_string(claims_verified), "claims.refused=" + std::to_string(claims_refused),
                                    "platforms.refused=" + std::to_string(refused_platforms)};
  for (const auto& e : space.by_type) items.push_back("type." + e.first + ".space=" + std::to_string(e.second));
  for (const auto& e : ground.by_type) items.push_back("type." + e.first + ".ground=" + std::to_string(e.second));
  const uint64_t at = std::max(oscar_latest, wiki_latest);
  if (push_notice(R::flowNoticeKind_Info, "sensor-counts", space.count + ground.count, items, at) < 0) return fail("output-failed", "The report could not be written.");
  if (!missing.empty() && push_notice(R::flowNoticeKind_Missing, "refused", missing.size(), missing, at) < 0) return fail("output-failed", "The report could not be written.");
  return 0;
}
