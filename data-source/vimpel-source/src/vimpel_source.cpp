// data-source/vimpel-source: JSC Vimpel's public orbit data as SDS records.
//
//   normalize_orbits  the osculating-element table (15 columns)  -> $OEM, one J2000 state per object
//   read_ephemeris    one rectangular ephemeris file (index, x, y, z) -> $OEM, position-only, 600 s apart
//   read_datefirst    the datefirst crosswalk (Nvym, t_det_v, Nnor, t_det_n) -> candidate links (JSON)
//
// Pure bytes in, pure bytes out: the login, retrieval and the archive (the ephemeris files come in a RAR) belong
// to the SDN host flow. Errors are flags (an invoke error code and message), never exceptions.
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

using Json = nlohmann::json;

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

const plugin_input_frame_t* frame_of(const char* port, size_t max_bytes) {
  for (uint32_t i = 0; i < plugin_get_input_count(); ++i) {
    const auto* f = plugin_get_input_frame(i);
    if (f && f->port_id && !std::strcmp(f->port_id, port)) {
      return f->payload && f->payload_length && f->payload_length <= max_bytes ? f : nullptr;
    }
  }
  return nullptr;
}

int push_json(const char* port, const Json& value) {
  const std::string text = value.dump();
  return plugin_push_output_ex(port, nullptr, nullptr, PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY, nullptr, 0, 1, reinterpret_cast<const uint8_t*>(text.data()),
                               static_cast<uint32_t>(text.size()));
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
  const auto* input = frame_of("source", kMaxTableBytes);
  if (!input) return fail("invalid-vimpel-orbits", "The source must be one bounded Vimpel orbit table.");
  std::vector<sdn::vimpel::Elements> records;
  if (!sdn::vimpel::elements(input->payload, input->payload_length, records)) {
    return fail("invalid-vimpel-orbits", "Malformed, duplicate or unsupported Vimpel orbit row; no output was published.");
  }
  const std::string text(reinterpret_cast<const char*>(input->payload), input->payload_length);
  const auto extras = extra_columns(text);
  if (extras.size() != records.size()) return fail("invalid-vimpel-orbits", "The table's rows and its states disagree.");
  const double rad = sdn::orbits::kPi / 180.0;
  std::vector<OEMT> states(records.size());
  Json objects = Json::array();
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
    objects.push_back({r.canonicalId, r.epoch, extras[k][0], extras[k][1], extras[k][2], extras[k][3], extras[k][4], extras[k][5]});
  }
  const Json report = {{"version", 1}, {"source", "vimpel"}, {"kind", "orbits"}, {"records", records.size()}, {"sha256", ephem::sha256_hex(input->payload, input->payload_length)},
                       {"bytes", input->payload_length}, {"muKm3PerS2", kMuKm3S2}, {"frame", "J2000"}, {"timeSystem", "UTC"},
                       {"columns", {"nativeId", "epoch", "firstObservation", "daysSinceUpdate", "areaToMassM2PerKg", "magnitude", "alongTrackTimingMinutes50", "transversePositionKm50"}},
                       {"objects", objects}};
  if (push_json("report", report) < 0) return 1;
  for (const OEMT& oem : states) {
    if (push_oem("states", oem) < 0) return 1;
  }
  return 0;
}

// ── a rectangular ephemeris file ──────────────────────────────────────────────────────────────────────

extern "C" int read_ephemeris(void) {
  const auto* name = frame_of("name", 256);
  const auto* input = frame_of("source", kMaxEphemerisBytes);
  if (!name || !input) return fail("invalid-vimpel-ephemeris", "A Vimpel ephemeris is its file name (<id>_<YYYYMMDD>_<HHMMSS>) and its rows.");
  sdn::vimpel::Positions positions;
  const std::string file(reinterpret_cast<const char*>(name->payload), name->payload_length);
  if (!sdn::vimpel::positions(input->payload, input->payload_length, file, positions)) {
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
  const Json report = {{"version", 1}, {"source", "vimpel"}, {"kind", "ephemeris"}, {"nativeId", positions.nativeId}, {"epoch", positions.epoch}, {"samples", positions.rows.size()},
                       {"stepSeconds", kEphemerisStepSeconds}, {"sha256", ephem::sha256_hex(input->payload, input->payload_length)}, {"frame", "J2000"}, {"timeSystem", "UTC"}};
  if (push_json("report", report) < 0) return 1;
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
  const auto* input = frame_of("source", kMaxTableBytes);
  if (!input) return fail("invalid-vimpel-datefirst", "The source must be one bounded datefirst file.");
  const std::string text(reinterpret_cast<const char*>(input->payload), input->payload_length);
  if (text.find('\0') != std::string::npos) return fail("invalid-vimpel-datefirst", "The datefirst file contains an embedded NUL.");
  std::istringstream stream(text);
  std::string line;
  bool header = false;
  size_t rows = 0, duplicate_lines = 0;
  std::vector<Edge> edges;
  std::map<std::string, size_t> by_pair;
  while (std::getline(stream, line)) {
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
  const std::string recordId = ephem::sha256_hex(input->payload, input->payload_length);
  Json links = Json::array(), conflicts = Json::array();
  size_t clean = 0, ambiguous = 0, dated = 0, unreadable = 0;
  std::set<std::string> vimpel_ids;
  std::set<uint32_t> noradNumbers;
  for (const Edge& e : edges) {
    const auto& m = members[e.component];
    const bool one_to_one = m.first.size() == 1 && m.second.size() == 1;
    (one_to_one ? clean : ambiguous) += 1;
    if (e.dates_differ) ++dated;
    vimpel_ids.insert(e.canonical);
    noradNumbers.insert(e.norad);
    Json link = {{"native", "vimpel:" + e.canonical}, {"nativeId", e.native_printed}, {"object", {{"norad", e.norad}}},
                 {"firstDetectedVimpel", e.t_vimpel.empty() ? Json(nullptr) : Json(e.t_vimpel)}, {"firstDetectedNorad", e.t_norad.empty() ? Json(nullptr) : Json(e.t_norad)},
                 {"declarations", e.declarations}, {"status", "candidate"}, {"ambiguous", !one_to_one}, {"evidence", {{"source", "datefirst"}, {"recordId", recordId}}}};
    if (e.t_vimpel.empty() || e.t_norad.empty()) {
      ++unreadable;
      link["datesAsPrinted"] = {e.raw_vimpel, e.raw_norad};
    }
    if (e.dates_differ) link["datesDiffer"] = true;
    links.push_back(std::move(link));
  }
  for (const auto& entry : members) {
    if (entry.second.first.size() == 1 && entry.second.second.size() == 1) continue;
    Json vimpel_list = Json::array(), norad_list = Json::array();
    for (const auto& id : entry.second.first) vimpel_list.push_back("vimpel:" + id);
    for (uint32_t n : entry.second.second) norad_list.push_back(n);
    conflicts.push_back({{"vimpel", vimpel_list}, {"norad", norad_list},
                         {"reason", entry.second.first.size() > 1 && entry.second.second.size() > 1 ? "several Vimpel numbers and several NORAD numbers are declared against each other"
                                    : entry.second.first.size() > 1 ? "one NORAD number is declared against several Vimpel numbers"
                                                                     : "one Vimpel number is declared against several NORAD numbers"}});
  }
  const Json crosswalk = {{"version", 1}, {"source", "vimpel"}, {"kind", "datefirst"}, {"status", "candidate"}, {"header", "Nvym t_det_v Nnor t_det_n"}, {"sha256", recordId},
                          {"bytes", input->payload_length}, {"rows", rows}, {"duplicateLines", duplicate_lines},
                          {"counts", {{"links", edges.size()}, {"clean", clean}, {"ambiguous", ambiguous}, {"vimpelNumbers", vimpel_ids.size()}, {"noradNumbers", noradNumbers.size()}, {"datesDiffer", dated}, {"unreadableDates", unreadable}}},
                          {"links", links}, {"conflicts", conflicts}};
  return push_json("crosswalk", crosswalk) < 0 ? 1 : 0;
}
