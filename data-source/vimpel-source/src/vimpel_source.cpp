// data-source/vimpel-source: JSC Vimpel's public orbit data as SDS records.
//
//   normalize_orbits  HttpResponse (HRSP) of the osculating-element table (15 columns) -> $OEM, one J2000 state per object,
//                     and the batch's IngestRequest (INGQ) on report
//   read_ephemeris    HRSP of one rectangular ephemeris file (index, x, y, z), the file name the last segment of its URL
//                     -> $OEM, position-only, 600 s apart, and the INGQ on report
//   read_datefirst    HRSP of the datefirst crosswalk (Nvym, t_det_v, Nnor, t_det_n) -> $OIL, candidate links
//   any method        HTTP 304 -> one FlowNotice (FNTC) Unchanged on unchanged, and nothing else
//
// Typed contracts 1.0: every port is one FlatBuffers type; the provider's text is only inside the response BODY.
// The login, retrieval and the archive (the ephemeris files come in a RAR) belong to the SDN host flow. Errors are
// flags (an invoke error code and message), never exceptions.
//
// The table and file layouts are read by files/orbit-products/src/vimpel.hpp, the one reader of the public
// format; the conversion of the printed elements to a state is foundation/orbits' cartesianFromKeplerian, the
// perifocal rotation Q = Rz(raan) Rx(i) Rz(omega) of the catalog paper (section 4) with mu = 398600.4418 km^3/s^2.
// The elements are osculating: the state is the printed elements' state at their reference epoch, an
// instantaneous conversion and no propagation. Nothing is invented: an object has the native identity
// `vimpel:<id>` and no NORAD number or international designator, and the 50 % uncertainty scalars, which
// do not state a covariance, stay in the report as printed.

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <map>
#include <memory>
#include <set>
#include <sstream>
#include <string>
#include <vector>

#include "HttpResponse_generated.h"
#include "IngestRequest_generated.h"
#include "FlowNotice_generated.h"

namespace R = sdn::runtime;

namespace {

constexpr double kMuKm3S2 = 398600.4418;  // km^3/s^2: the paper's value, and the one orbit-products' normalize_vimpel uses
constexpr size_t kMaxTableBytes = 8u * 1024 * 1024;
constexpr size_t kMaxEphemerisBytes = 4u * 1024 * 1024;
constexpr size_t kMaxObjects = 20000;
constexpr const char* kCatalogUri = "http://spacedata.vimpel.ru/";
constexpr double kEphemerisStepSeconds = 600.0;

int fail(const char* code, const std::string& message) {
  plugin_set_error(code, message.c_str());
  return 1;
}

int push(const char* port, const char* schema, const char* id, const char* root, const uint8_t* data, size_t size) {
  return plugin_push_output_ex(port, schema, id, PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, root, 0, 0, data, static_cast<uint32_t>(size));
}

// The one input of every method: the HttpResponse hostcap/http-request answers, BODY the provider's file verbatim.
struct Response {
  const uint8_t* body = nullptr;
  size_t size = 0;
  std::string url;
  int32_t status = 0;
  uint64_t retrieved_ms = 0;
  bool unchanged = false;
};

// 0: a bounded 200 body in `out`, or a 304 (out.unchanged, the FlowNotice already pushed). Otherwise the error is set.
int read_response(const char* code, const char* schema, size_t max_bytes, Response& out) {
  if (plugin_get_input_count() != 1) return fail(code, "Exactly one HttpResponse (HRSP) on response is required.");
  const auto* f = plugin_get_input_frame(0);
  if (!f || !f->port_id || std::strcmp(f->port_id, "response") || !f->payload) return fail(code, "The input must be one HttpResponse (HRSP) on response.");
  flatbuffers::Verifier verifier(f->payload, f->payload_length);
  if (!R::VerifyHttpResponseBuffer(verifier)) return fail("invalid-response-frame", "The input on response is not an HttpResponse (HRSP).");
  const R::HttpResponse& http = *R::GetHttpResponse(f->payload);
  out.url = http.URL() ? http.URL()->str() : std::string();
  out.status = http.STATUS();
  out.retrieved_ms = http.RETRIEVED_MS();
  if (http.STATUS() == 304) {
    out.unchanged = true;
    R::FlowNoticeT n;
    n.KIND = R::flowNoticeKind_Unchanged;
    n.SCHEMA = schema;
    n.SOURCE_NAME = "vimpel";
    n.REASON = "not-modified";
    n.COUNT = 1;
    if (!out.url.empty()) n.ITEMS.push_back(out.url);
    flatbuffers::FlatBufferBuilder b(256);
    R::FinishFlowNoticeBuffer(b, R::FlowNotice::Pack(b, &n));
    return push("unchanged", "FlowNotice.fbs", R::FlowNoticeIdentifier(), "FlowNotice", b.GetBufferPointer(), b.GetSize()) < 0 ? 1 : 0;
  }
  if (http.STATUS() != 200 || (http.ERROR() && http.ERROR()->size())) return fail("fetch-failed", "The response is not HTTP 200: " + std::to_string(http.STATUS()) + (http.ERROR() ? " " + http.ERROR()->str() : std::string()));
  const auto* body = http.BODY();
  if (!body || !body->size() || body->size() > max_bytes) return fail(code, "The response body is empty or exceeds the bound.");
  out.body = body->data();
  out.size = body->size();
  return 0;
}

// The batch's IngestRequest: what was read, the provider's columns as ATTRIBUTES in the order given.
int push_meta(const Response& in, const std::string& sha, const char* parser_version, uint64_t count, const std::vector<std::pair<std::string, std::string>>& attributes) {
  R::IngestRequestT meta;
  meta.SCHEMA = "OEM.fbs";
  meta.TAGS = std::make_unique<R::SourceTagsT>();
  meta.TAGS->SOURCE_NAME = "vimpel";
  meta.TAGS->SOURCE_URL = in.url;
  meta.TAGS->BATCH_ID = sha;
  meta.PROVENANCE = std::make_unique<R::ProvenanceT>();
  auto& p = *meta.PROVENANCE;
  p.SOURCE_URL = in.url;
  p.HTTP_STATUS = in.status;
  p.RETRIEVED_MS = in.retrieved_ms;
  p.PARSER = "vimpel-source";
  p.PARSER_VERSION = parser_version;
  p.SOURCE_SHA256 = sha;
  p.NORMALIZED_COUNT = count;
  p.SCHEMAS = {"OEM.fbs"};
  p.SCHEMA_COUNTS = {count};
  for (const auto& entry : attributes) {
    auto h = std::make_unique<R::HeaderT>();
    h->NAME = entry.first;
    h->VALUE = entry.second;
    p.ATTRIBUTES.push_back(std::move(h));
  }
  flatbuffers::FlatBufferBuilder b(1024);
  R::FinishIngestRequestBuffer(b, R::IngestRequest::Pack(b, &meta));
  return push("report", "IngestRequest.fbs", R::IngestRequestIdentifier(), "IngestRequest", b.GetBufferPointer(), b.GetSize());
}

// "YYYY-MM-DDTHH:MM:SSZ" as vimpel.hpp writes it -> "YYYY-MM-DDTHH:MM:SS.000000" (the scale is TIME_SYSTEM's).
std::string epoch_text(const std::string& vimpel_iso) { return vimpel_iso.substr(0, 19) + ".000000"; }

// The native identity of an object: its OBJECT_NAME is vimpel:<id> (leading zeros dropped, as the provider's own
// number is an integer), and CATALOG_URI with CATALOG_OBJECT_ID name the provider's namespace and the exact id.
std::unique_ptr<CATT> native_object(const std::string& canonical_id) {
  auto cat = std::make_unique<CATT>();
  cat->OBJECT_NAME = "vimpel:" + canonical_id;
  cat->CATALOG_URI = kCatalogUri;
  cat->CATALOG_OBJECT_ID = canonical_id;
  return cat;
}

std::unique_ptr<RFMT> j2000() {
  auto frame = std::make_unique<RFMT>();
  frame->NAME = "J2000";
  CelestialFrameWrapperT wrapper;
  wrapper.frame = CelestialFrame::J2000;
  frame->REFERENCE_FRAME.Set(std::move(wrapper));
  return frame;
}

std::unique_ptr<ephemerisDataBlockT> earth_block(const std::string& canonical_id) {
  auto block = std::make_unique<ephemerisDataBlockT>();
  block->OBJECT = native_object(canonical_id);
  block->CENTER_NAME = "EARTH";
  block->REFERENCE_FRAME = j2000();
  block->TIME_SYSTEM = timingStandard::UTC;
  return block;
}

int push_oem(const char* port, const OEMT& oem) {
  flatbuffers::FlatBufferBuilder fbb(1024);
  FinishOEMBuffer(fbb, CreateOEM(fbb, &oem));
  return plugin_push_output_ex(port, "OEM.fbs", "$OEM", PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, "OEM", 0, 0, fbb.GetBufferPointer(), fbb.GetSize());
}

// ── the osculating-element table ──────────────────────────────────────────────────────────────────────

// The columns vimpel.hpp does not turn into a state (first observation, age, area/mass, magnitude, the two
// uncertainty scalars), verbatim, for the report: unknown markers ("-") and signed ages are the provider's
// and stay as printed, never coerced into numbers.
std::vector<std::array<std::string, 6>> extra_columns(const std::string& text) {
  std::vector<std::array<std::string, 6>> rows;
  std::istringstream stream(text);
  std::string line;
  while (std::getline(stream, line)) {
    if (sdn::vimpel::trim(line).empty()) continue;
    std::vector<std::string> f;
    size_t a = 0;
    for (size_t b = 0; b <= line.size(); ++b) {
      if (b == line.size() || line[b] == ',') {
        f.push_back(sdn::vimpel::trim(line.substr(a, b - a)));
        a = b + 1;
      }
    }
    rows.push_back({f[2], f[4], f[11], f[12], f[13], f[14]});
  }
  return rows;
}

}  // namespace

extern "C" int normalize_orbits(void) {
  Response in;
  if (read_response("invalid-vimpel-orbits", "OEM.fbs", kMaxTableBytes, in) || in.unchanged) return in.unchanged ? 0 : 1;
  std::vector<sdn::vimpel::Elements> records;
  if (!sdn::vimpel::elements(in.body, in.size, records)) {
    return fail("invalid-vimpel-orbits", "Malformed, duplicate or unsupported Vimpel orbit row; no output was published.");
  }
  const std::string text(reinterpret_cast<const char*>(in.body), in.size);
  const auto extras = extra_columns(text);
  if (extras.size() != records.size()) return fail("invalid-vimpel-orbits", "The table's rows and its states disagree.");
  const double rad = sdn::orbits::kPi / 180.0;
  std::vector<OEMT> states(records.size());
  std::vector<std::pair<std::string, std::string>> objects;
  for (size_t k = 0; k < records.size(); ++k) {
    const auto& r = records[k];
    const auto& v = r.values;  // a (km), i, raan (deg), e, u, omega (deg)
    // True anomaly is the argument of latitude less the argument of perigee.
    const double anomaly = std::fmod(v[4] - v[5] + 360.0, 360.0);
    const sdn::orbits::Keplerian elements{v[0] * 1000.0, v[3], v[1] * rad, v[2] * rad, v[5] * rad, anomaly * rad};
    sdn::orbits::Cartesian state;
    if (!sdn::orbits::cartesianFromKeplerian(elements, kMuKm3S2 * 1.0e9, &state) || sdn::orbits::norm(state.position) <= 6356752.3) {
      return fail("invalid-vimpel-orbits", "The osculating elements of object " + r.canonicalId + " do not give a finite state outside the Earth.");
    }
    OEMT& oem = states[k];
    oem.ORIGINATOR = "JSC Vimpel";
    oem.COMMENT = "Vimpel osculating elements (HEO product) as the state at their reference epoch: instantaneous two-body conversion, mu = 398600.4418 km^3/s^2, J2000 axes, UTC; not propagated.";
    auto block = earth_block(r.canonicalId);
    block->START_TIME = block->STOP_TIME = epoch_text(r.epoch);
    block->STEP_SIZE = 0.0;
    auto line = std::make_unique<ephemerisDataLineT>();
    line->EPOCH = epoch_text(r.epoch);
    line->X = state.position.x / 1000.0;
    line->Y = state.position.y / 1000.0;
    line->Z = state.position.z / 1000.0;
    line->X_DOT = state.velocity.x / 1000.0;
    line->Y_DOT = state.velocity.y / 1000.0;
    line->Z_DOT = state.velocity.z / 1000.0;
    block->EPHEMERIS_DATA_LINES.push_back(std::move(line));
    oem.EPHEMERIS_DATA_BLOCK.push_back(std::move(block));
    // One attribute per object, in table order: its columns as printed, joined by commas as the table writes them.
    std::string columns = r.canonicalId + "," + r.epoch;
    for (const auto& c : extras[k]) columns += "," + c;
    objects.emplace_back("object." + std::to_string(k + 1), columns);
  }
  std::vector<std::pair<std::string, std::string>> attributes = {
      {"kind", "orbits"}, {"records", std::to_string(records.size())}, {"bytes", std::to_string(in.size)}, {"muKm3PerS2", "398600.4418"}, {"frame", "J2000"}, {"timeSystem", "UTC"},
      {"columns", "nativeId,epoch,firstObservation,daysSinceUpdate,areaToMassM2PerKg,magnitude,alongTrackTimingMinutes50,transversePositionKm50"}};
  attributes.insert(attributes.end(), objects.begin(), objects.end());
  if (push_meta(in, ephem::sha256_hex(in.body, in.size), "vimpel-orbits-1", records.size(), attributes) < 0) return 1;
  for (const OEMT& oem : states) {
    if (push_oem("states", oem) < 0) return 1;
  }
  return 0;
}

// ── a rectangular ephemeris file ──────────────────────────────────────────────────────────────────────

extern "C" int read_ephemeris(void) {
  Response in;
  if (read_response("invalid-vimpel-ephemeris", "OEM.fbs", kMaxEphemerisBytes, in) || in.unchanged) return in.unchanged ? 0 : 1;
  // The file name (<id>_<YYYYMMDD>_<HHMMSS>) is the last segment of the response URL, query and fragment dropped.
  std::string file = in.url.substr(0, in.url.find_first_of("?#"));
  file = file.substr(file.find_last_of('/') == std::string::npos ? 0 : file.find_last_of('/') + 1);
  if (file.empty() || file.size() > 256) return fail("invalid-vimpel-ephemeris", "A Vimpel ephemeris is its file name (<id>_<YYYYMMDD>_<HHMMSS>, the URL's last segment) and its rows.");
  sdn::vimpel::Positions positions;
  if (!sdn::vimpel::positions(in.body, in.size, file, positions)) {
    return fail("invalid-vimpel-ephemeris", "Malformed Vimpel ephemeris: the file name, an index that is not the row number, a position inside the Earth, or fewer than five rows.");
  }
  double start = 0;
  if (!sdn_time::parse_iso(positions.epoch, &start)) return fail("invalid-vimpel-ephemeris", "The file name's epoch is not a time.");
  OEMT oem;
  oem.ORIGINATOR = "JSC Vimpel";
  oem.COMMENT = "Vimpel rectangular ephemeris: J2000 positions every 600 s from the epoch in the file name, UTC; position only (no velocity is derived from the rounded positions).";
  auto block = earth_block(positions.nativeId);
  block->START_TIME = epoch_text(positions.epoch);
  block->STOP_TIME = sdn_time::format_iso_micro(static_cast<int64_t>(std::llround((start + kEphemerisStepSeconds * (positions.rows.size() - 1)) * 1.0e6)));
  block->STEP_SIZE = kEphemerisStepSeconds;
  block->STATE_VECTOR_SIZE = 3;  // position only, as every position-only source of this repository writes it
  block->EPHEMERIS_DATA.reserve(positions.rows.size() * 3);
  for (const auto& row : positions.rows) block->EPHEMERIS_DATA.insert(block->EPHEMERIS_DATA.end(), row.begin(), row.end());
  oem.EPHEMERIS_DATA_BLOCK.push_back(std::move(block));
  const std::vector<std::pair<std::string, std::string>> attributes = {
      {"kind", "ephemeris"}, {"fileName", file}, {"nativeId", positions.nativeId}, {"epoch", positions.epoch}, {"samples", std::to_string(positions.rows.size())},
      {"stepSeconds", "600"}, {"bytes", std::to_string(in.size)}, {"frame", "J2000"}, {"timeSystem", "UTC"}};
  if (push_meta(in, ephem::sha256_hex(in.body, in.size), "vimpel-ephemeris-1", 1, attributes) < 0) return 1;
  return push_oem("ephemeris", oem) < 0 ? 1 : 0;
}

// ── the datefirst crosswalk ───────────────────────────────────────────────────────────────────────────

namespace {

bool eight_digits(const std::string& text) { return text.size() == 8 && sdn::vimpel::digits(text); }

// YYYYMMDD -> YYYY-MM-DD, or "" when the digits are not a calendar date. The provider's file has such dates (month 95,
// day 91): the pairing they sit in is still the provider's declaration, so the row is kept and the date is not made up.
std::string iso_date8(const std::string& yyyymmdd) {
  const int y = std::atoi(yyyymmdd.substr(0, 4).c_str()), m = std::atoi(yyyymmdd.substr(4, 2).c_str()), d = std::atoi(yyyymmdd.substr(6, 2).c_str());
  if (!sdn_time::valid_date(y, m, d)) return "";
  return yyyymmdd.substr(0, 4) + "-" + yyyymmdd.substr(4, 2) + "-" + yyyymmdd.substr(6, 2);
}

struct Edge {
  std::string native_printed, canonical;
  uint32_t norad = 0;
  std::string t_vimpel, t_norad;          // ISO dates, "" when the printed digits are not a date
  std::string raw_vimpel, raw_norad;      // the digits as printed
  size_t declarations = 1;
  uint32_t line = 0;                      // 1-based line of the first declaration in the file
  bool dates_differ = false;
  size_t component = 0;
};

// Union-find over the Vimpel ids and the NORAD numbers an edge joins.
struct Components {
  std::vector<size_t> parent;
  size_t add() { parent.push_back(parent.size()); return parent.size() - 1; }
  size_t find(size_t x) { while (parent[x] != x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; }
  void join(size_t a, size_t b) { parent[find(a)] = find(b); }
};

}  // namespace

extern "C" int read_datefirst(void) {
  Response in;
  if (read_response("invalid-vimpel-datefirst", "OIL.fbs", kMaxTableBytes, in) || in.unchanged) return in.unchanged ? 0 : 1;
  const std::string text(reinterpret_cast<const char*>(in.body), in.size);
  if (text.find('\0') != std::string::npos) return fail("invalid-vimpel-datefirst", "The datefirst file contains an embedded NUL.");
  std::istringstream stream(text);
  std::string line;
  bool header = false;
  size_t rows = 0, duplicate_lines = 0;
  std::vector<Edge> edges;
  std::map<std::string, size_t> by_pair;
  uint32_t line_number = 0;
  while (std::getline(stream, line)) {
    ++line_number;
    std::istringstream cells(line);
    std::vector<std::string> f;
    for (std::string cell; cells >> cell;) f.push_back(cell);
    if (f.empty()) continue;
    if (!header) {
      if (f.size() != 4 || f[0] != "Nvym" || f[1] != "t_det_v" || f[2] != "Nnor" || f[3] != "t_det_n") {
        return fail("invalid-vimpel-datefirst", "The first line must be the header `Nvym t_det_v Nnor t_det_n`.");
      }
      header = true;
      continue;
    }
    ++rows;
    uint32_t norad = 0;
    if (f.size() == 4 && sdn::vimpel::digits(f[2]) && f[2].size() <= 9) norad = static_cast<uint32_t>(std::strtoul(f[2].c_str(), nullptr, 10));
    if (f.size() != 4 || !sdn::vimpel::digits(f[0]) || f[0].size() > 12 || sdn::vimpel::identity(f[0]) == "0" || norad == 0 || !eight_digits(f[1]) || !eight_digits(f[3])) {
      return fail("invalid-vimpel-datefirst", "Malformed datefirst row " + std::to_string(rows) + ": four fields (a Vimpel number, a date of eight digits, a NORAD number, a date of eight digits) are required.");
    }
    const std::string tv = iso_date8(f[1]), tn = iso_date8(f[3]);
    if (rows > 1000000) return fail("invalid-vimpel-datefirst", "The datefirst file exceeds 1,000,000 rows.");
    const std::string canonical = sdn::vimpel::identity(f[0]);
    const std::string key = canonical + "/" + std::to_string(norad);
    const auto found = by_pair.find(key);
    if (found != by_pair.end()) {
      Edge& e = edges[found->second];
      ++e.declarations;
      ++duplicate_lines;
      if (e.raw_vimpel != f[1] || e.raw_norad != f[3]) e.dates_differ = true;
      continue;
    }
    by_pair[key] = edges.size();
    Edge e;
    e.native_printed = f[0];
    e.canonical = canonical;
    e.norad = norad;
    e.t_vimpel = tv;
    e.t_norad = tn;
    e.raw_vimpel = f[1];
    e.raw_norad = f[3];
    e.line = line_number;
    edges.push_back(e);
  }
  if (!header || edges.empty()) return fail("invalid-vimpel-datefirst", "No datefirst row was supplied.");
  // Components of the graph the declarations draw: one Vimpel number to one NORAD number is a candidate; a number on
  // either side that is declared against two on the other is an alias or a conflict, and no link of it binds.
  Components graph;
  std::map<std::string, size_t> node;
  auto node_of = [&](const std::string& key) {
    auto it = node.find(key);
    if (it != node.end()) return it->second;
    return node[key] = graph.add();
  };
  for (const Edge& e : edges) graph.join(node_of("v:" + e.canonical), node_of("n:" + std::to_string(e.norad)));
  std::map<size_t, std::pair<std::set<std::string>, std::set<uint32_t>>> members;
  for (Edge& e : edges) {
    e.component = graph.find(node_of("v:" + e.canonical));
    members[e.component].first.insert(e.canonical);
    members[e.component].second.insert(e.norad);
  }
  const std::string recordId = ephem::sha256_hex(in.body, in.size);
  OILT oil;
  oil.PROVIDER = "vimpel";
  oil.KIND = "datefirst";
  oil.LEFT_NAMESPACE = "vimpel";
  oil.RIGHT_NAMESPACE = "NORAD";
  oil.HEADER = "Nvym t_det_v Nnor t_det_n";
  oil.SHA256 = recordId;
  oil.BYTES = in.size;
  oil.ROWS = static_cast<uint32_t>(rows);
  oil.DUPLICATE_LINES = static_cast<uint32_t>(duplicate_lines);
  size_t clean = 0, ambiguous = 0, dated = 0, unreadable = 0;
  std::set<std::string> vimpel_ids;
  std::set<uint32_t> noradNumbers;
  auto identifier = [](const char* ns, const std::string& id, const std::string& printed, const std::string& date, const std::string& raw_date) {
    auto i = std::make_unique<OILIdentifierT>();
    i->NAMESPACE = ns;
    i->ID = id;
    if (printed != id) i->ID_AS_PRINTED = printed;
    i->FIRST_DETECTED = date;
    if (date.empty()) i->FIRST_DETECTED_AS_PRINTED = raw_date;
    return i;
  };
  for (const Edge& e : edges) {
    const auto& m = members[e.component];
    const bool one_to_one = m.first.size() == 1 && m.second.size() == 1;
    (one_to_one ? clean : ambiguous) += 1;
    if (e.dates_differ) ++dated;
    if (e.t_vimpel.empty() || e.t_norad.empty()) ++unreadable;
    vimpel_ids.insert(e.canonical);
    noradNumbers.insert(e.norad);
    auto link = std::make_unique<OILLinkT>();
    link->LEFT = identifier("vimpel", e.canonical, e.native_printed, e.t_vimpel, e.raw_vimpel);
    const std::string norad = std::to_string(e.norad);
    link->RIGHT = identifier("NORAD", norad, norad, e.t_norad, e.raw_norad);
    link->RIGHT->NORAD_CAT_ID = e.norad;
    // A datefirst row proposes a link; it does not prove one. Ambiguity is the flag, the status stays Candidate.
    link->STATUS = oilLinkStatus::Candidate;
    link->AMBIGUOUS = !one_to_one;
    link->EVIDENCE = std::make_unique<OILEvidenceT>();
    link->EVIDENCE->SOURCE = "datefirst";
    link->EVIDENCE->RECORD_ID = recordId;
    link->EVIDENCE->LINE = e.line;
    link->EVIDENCE->DECLARATIONS = static_cast<uint32_t>(e.declarations);
    link->EVIDENCE->DATES_DIFFER = e.dates_differ;
    oil.LINKS.push_back(std::move(link));
  }
  for (const auto& entry : members) {
    const size_t nv = entry.second.first.size(), nn = entry.second.second.size();
    if (nv == 1 && nn == 1) continue;
    auto c = std::make_unique<OILConflictT>();
    for (const auto& id : entry.second.first) c->LEFT_IDS.push_back("vimpel:" + id);
    for (uint32_t n : entry.second.second) c->RIGHT_IDS.push_back("NORAD:" + std::to_string(n));
    c->SHAPE = nv > 1 && nn > 1 ? oilConflictShape::ManyLeftManyRight : nv > 1 ? oilConflictShape::ManyLeftOneRight : oilConflictShape::OneLeftManyRight;
    c->REASON = nv > 1 && nn > 1 ? "several Vimpel numbers and several NORAD numbers are declared against each other"
                : nv > 1     ? "one NORAD number is declared against several Vimpel numbers"
                             : "one Vimpel number is declared against several NORAD numbers";
    oil.CONFLICTS.push_back(std::move(c));
  }
  oil.LINK_COUNT = static_cast<uint32_t>(edges.size());
  oil.CLEAN_COUNT = static_cast<uint32_t>(clean);
  oil.AMBIGUOUS_COUNT = static_cast<uint32_t>(ambiguous);
  oil.LEFT_ID_COUNT = static_cast<uint32_t>(vimpel_ids.size());
  oil.RIGHT_ID_COUNT = static_cast<uint32_t>(noradNumbers.size());
  oil.DATES_DIFFER_COUNT = static_cast<uint32_t>(dated);
  oil.UNREADABLE_DATE_COUNT = static_cast<uint32_t>(unreadable);
  flatbuffers::FlatBufferBuilder b(4096);
  FinishOILBuffer(b, OIL::Pack(b, &oil));
  return push("crosswalk", "OIL.fbs", "$OIL", "OIL", b.GetBufferPointer(), b.GetSize()) < 0 ? 1 : 0;
}
