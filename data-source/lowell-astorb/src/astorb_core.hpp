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
// parts). One copy of the fixed-column rules and the $SBD layout.
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
// The largest tenth of the numbered asteroids (owner 2026-10-13: "only the
// largest 10% showing by default"): its own lane, a deterministic subset of
// the same records (rankSizeKm below).
constexpr const char* largestSourceName = "astorb-largest-10pct";
// The catalog listing: one $EGP group per lane (owner 2026-10-13: "we need
// them as a group that is listed on the network (a catalog)").
constexpr const char* groupsSourceName = "astorb-groups";
constexpr const char* cadence = "72h";
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
  std::string name;  // UTF-8: an IAU name, or the provisional designation of an unnamed body
  bool hasH, hasG, hasD, hasArc, hasObs, hasCeu, hasCeuRate;
  double h, g, d, arc, obs, ceu, ceuRate;
  std::string epoch, ceuEpoch;
  double m, w, node, inc, e, aAu;
};

// An unnamed numbered asteroid carries its principal provisional designation
// in the name columns: "1999 RQ36", or a survey designation ("2040 P-L",
// "3138 T-1").
bool isDesignation(const std::string& s) {
  if (s.size() < 7 || s[4] != ' ') return false;
  for (int i = 0; i < 4; ++i) if (s[i] < '0' || s[i] > '9') return false;
  const std::string t = s.substr(5);
  if (t == "P-L" || t == "T-1" || t == "T-2" || t == "T-3") return true;
  if (t.size() < 2 || t[0] < 'A' || t[0] > 'Z' || t[1] < 'A' || t[1] > 'Z') return false;
  for (size_t i = 2; i < t.size(); ++i) if (t[i] < '0' || t[i] > '9') return false;
  return true;
}

// JPL SBDB asteroid orbit classes from a (AU) and e (sbdOrbitClass).
sbdOrbitClass orbitClass(double aAu, double e) {
  if (e == 1.0) return sbdOrbitClass::PAA;
  if (e > 1.0) return sbdOrbitClass::HYA;
  const double q = aAu * (1.0 - e), big = aAu * (1.0 + e);
  if (aAu < 1.0) return big < 0.983 ? sbdOrbitClass::IEO : sbdOrbitClass::ATE;
  if (q < 1.017) return sbdOrbitClass::APO;
  if (q < 1.3) return sbdOrbitClass::AMO;
  if (q < 1.666 && aAu < 3.2) return sbdOrbitClass::MCA;
  if (aAu < 2.0) return sbdOrbitClass::IMB;
  if (aAu < 3.2) return sbdOrbitClass::MBA;
  if (aAu < 4.6) return sbdOrbitClass::OMB;
  if (aAu < 5.5) return e < 0.3 ? sbdOrbitClass::TJN : sbdOrbitClass::AST;
  if (aAu < 30.1) return sbdOrbitClass::CEN;
  return sbdOrbitClass::TNO;
}

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
  // Orbit quality: the observed arc (days), the observations used and the
  // current ephemeris uncertainty (CEU, arcsec), its rate and its date.
  row.hasArc = numberField(line, 95, 100, row.arc);
  row.hasObs = numberField(line, 100, 105, row.obs);
  row.hasCeu = len >= 216 && numberField(line, 190, 199, row.ceu);
  row.hasCeuRate = len >= 216 && numberField(line, 199, 207, row.ceuRate);
  row.ceuEpoch.clear();
  if (len >= 216) {
    bool digits = true;
    for (size_t i = 208; i < 216; ++i) digits = digits && line[i] >= '0' && line[i] <= '9';
    if (digits) {
      const char* cp = line + 208;
      row.ceuEpoch = std::string(cp, 4) + "-" + std::string(cp + 4, 2) + "-" + std::string(cp + 6, 2);
    }
  }
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

// ── the largest 10% ─────────────────────────────────────────────────────────
// A row's size: the catalog (IRAS) diameter when astorb gives one, else the
// equivalent-sphere diameter from its absolute magnitude at geometric albedo
// 0.14, D = 1329 km / sqrt(p) x 10^(-H/5) (Fowler & Chillemi 1992; the albedo
// of the 140 m NEO threshold at H = 22). A row with neither ranks last. The
// rows are ranked largest first, ties by number (a total order, so the subset
// is the same in every runtime), and the first ceil(N/10) are the subset.
constexpr double rankAlbedo = 0.14;
double rankSizeKm(const Row& r) {
  if (r.hasD && r.d > 0) return r.d;
  if (r.hasH) return 1329.0 / std::sqrt(rankAlbedo) * std::pow(10.0, -r.h / 5.0);
  return 0.0;
}
struct Largest {
  std::vector<uint8_t> member;  // by asteroid number: 1 = in the subset
  size_t count = 0, measured = 0;
  double smallestKm = 0;
  bool has(int64_t number) const { return number >= 0 && size_t(number) < member.size() && member[size_t(number)]; }
};
struct RankedRow { float km; uint32_t number; bool measured; };
void chooseLargest(std::vector<RankedRow>& rows, Largest& out) {
  out.count = (rows.size() + 9) / 10;
  if (out.count == 0) return;
  const auto larger = [](const RankedRow& a, const RankedRow& b) { return a.km != b.km ? a.km > b.km : a.number < b.number; };
  std::nth_element(rows.begin(), rows.begin() + (out.count - 1), rows.end(), larger);
  uint32_t maxNumber = 0;
  for (size_t i = 0; i < out.count; ++i) maxNumber = std::max(maxNumber, rows[i].number);
  out.member.assign(size_t(maxNumber) + 1, 0);
  out.smallestKm = rows[out.count - 1].km;
  for (size_t i = 0; i < out.count; ++i) {
    out.member[rows[i].number] = 1;
    if (rows[i].measured) ++out.measured;
  }
}

// ── Earth MOID and PHA ──────────────────────────────────────────────────────
// astorb.dat carries no Earth MOID or hazard flag (its integer codes give the
// planet-crossing class only), so the module computes the minimum orbit
// intersection distance against the Earth's orbit at the row's epoch for every
// NEO (q < 1.3 AU; no other orbit can come within 0.05 AU of the Earth's,
// whose aphelion is 1.0167 AU). The Earth's orbit is the Earth-Moon
// barycentre's mean orbit, mean ecliptic and equinox of J2000 (Standish,
// "Keplerian Elements for Approximate Positions of the Major Planets", JPL SSD,
// Table 1, 1800-2050): its orbit, not its place, is all a MOID needs, and the
// table's error (tens of arcseconds) moves a MOID by under 1e-4 AU. PHA (JPL/MPC
// definition): Earth MOID <= 0.05 AU and H <= 22.
constexpr double moidPhaAu = 0.05;
constexpr double phaMaxH = 22.0;
constexpr double degToRad = 3.14159265358979323846 / 180.0;
constexpr double twoPi = 2.0 * 3.14159265358979323846;
struct Conic { double a, e, p[3], q[3]; };
Conic conic(double aAu, double e, double incDeg, double nodeDeg, double argDeg) {
  const double cn = std::cos(nodeDeg * degToRad), sn = std::sin(nodeDeg * degToRad);
  const double ci = std::cos(incDeg * degToRad), si = std::sin(incDeg * degToRad);
  const double cw = std::cos(argDeg * degToRad), sw = std::sin(argDeg * degToRad);
  return {aAu, e, {cn * cw - sn * sw * ci, sn * cw + cn * sw * ci, sw * si}, {-cn * sw - sn * cw * ci, -sn * sw + cn * cw * ci, cw * si}};
}
void conicPoint(const Conic& c, double ecc, double out[3]) {
  const double x = c.a * (std::cos(ecc) - c.e), y = c.a * std::sqrt(1.0 - c.e * c.e) * std::sin(ecc);
  for (int k = 0; k < 3; ++k) out[k] = x * c.p[k] + y * c.q[k];
}
// The Earth's (EMB) orbit at a "YYYY-MM-DDT00:00:00" TDB epoch.
Conic earthOrbit(const std::string& epoch) {
  const int y = std::atoi(epoch.substr(0, 4).c_str()), m = std::atoi(epoch.substr(5, 2).c_str()), d = std::atoi(epoch.substr(8, 2).c_str());
  // Julian date at 0h (Fliegel & Van Flandern), centuries from J2000.
  const long jdn = (1461L * (y + 4800 + (m - 14) / 12)) / 4 + (367L * (m - 2 - 12 * ((m - 14) / 12))) / 12 -
                   (3L * ((y + 4900 + (m - 14) / 12) / 100)) / 4 + d - 32075;
  const double t = (double(jdn) - 0.5 - 2451545.0) / 36525.0;
  const double a = 1.00000261 + 0.00000562 * t, e = 0.01671123 - 0.00004392 * t;
  const double inc = -0.00001531 - 0.01294668 * t, varpi = 102.93768193 + 0.32327364 * t, node = 0.0;
  return conic(a, e, inc, node, varpi - node);
}
double distance2(const double a[3], const double b[3]) {
  const double x = a[0] - b[0], y = a[1] - b[1], z = a[2] - b[2];
  return x * x + y * y + z * z;
}
// Minimum distance (AU) between two confocal elliptic orbits: a 360 x 180
// eccentric-anomaly grid, then a pattern search from each of the grid's
// four lowest local minima down to 1e-10 rad (the two orbits can have up to
// four local minima; the grid finds every basin wider than a cell).
double moidAu(const Conic& body, const Conic& earth) {
  constexpr int nb = 360, ne = 180;
  static std::vector<double> earthPts;
  static Conic cached{};
  if (earthPts.empty() || std::memcmp(&cached, &earth, sizeof(Conic)) != 0) {
    earthPts.resize(3 * ne);
    for (int j = 0; j < ne; ++j) conicPoint(earth, twoPi * j / ne, &earthPts[3 * j]);
    cached = earth;
  }
  std::vector<double> grid(size_t(nb) * ne);
  double pb[3];
  for (int i = 0; i < nb; ++i) {
    conicPoint(body, twoPi * i / nb, pb);
    for (int j = 0; j < ne; ++j) grid[size_t(i) * ne + j] = distance2(pb, &earthPts[3 * j]);
  }
  struct Seed { double d2; int i, j; };
  std::vector<Seed> seeds;
  for (int i = 0; i < nb; ++i)
    for (int j = 0; j < ne; ++j) {
      const double v = grid[size_t(i) * ne + j];
      bool minimum = true;
      for (int di = -1; di <= 1 && minimum; ++di)
        for (int dj = -1; dj <= 1; ++dj) {
          if (!di && !dj) continue;
          if (grid[size_t((i + di + nb) % nb) * ne + (j + dj + ne) % ne] < v) { minimum = false; break; }
        }
      if (minimum) seeds.push_back({v, i, j});
    }
  std::sort(seeds.begin(), seeds.end(), [](const Seed& x, const Seed& y) { return x.d2 < y.d2; });
  if (seeds.size() > 4) seeds.resize(4);
  double best = seeds.empty() ? *std::min_element(grid.begin(), grid.end()) : seeds[0].d2;
  double pe[3];
  const auto at = [&](double u, double v) { conicPoint(body, u, pb); conicPoint(earth, v, pe); return distance2(pb, pe); };
  for (const auto& seed : seeds) {
    double u = twoPi * seed.i / nb, v = twoPi * seed.j / ne, d2 = seed.d2;
    double step = twoPi / ne;
    while (step > 1e-10) {
      bool moved = false;
      for (int du = -1; du <= 1; ++du)
        for (int dv = -1; dv <= 1; ++dv) {
          if (!du && !dv) continue;
          const double t = at(u + du * step, v + dv * step);
          if (t < d2) { d2 = t; u += du * step; v += dv * step; moved = true; }
        }
      if (!moved) step *= 0.5;
    }
    best = std::min(best, d2);
  }
  return std::sqrt(best);
}

// One $SBD: the catalog's osculating heliocentric elements as published
// (CENTER_NAME SUN, REF_FRAME ECLIPJ2000: the mean ecliptic and equinox of
// J2000; TIME_SYSTEM TDB, the epoch of osculation; angles in degrees,
// SEMI_MAJOR_AXIS in km, the only arithmetic: AU to km; GM the DE440 Sun),
// H, G, the IRAS diameter, the orbit class and the orbit quality astorb gives,
// and the record's provenance (PVN).
void buildRecord(const Row& r, flatbuffers::FlatBufferBuilder& b) {
  b.Clear();
  const auto lane = b.CreateSharedString(providerId);
  const auto originator = b.CreateSharedString("Lowell Observatory");
  const auto licenceId = b.CreateSharedString("lowell-astorb-attribution");
  const auto provenance = CreatePVN(b, lane, pvnSourceKind::ElementSet, originator, lane, 0,
                                    pvnLicenseClass::Reproducible, licenceId, lane);
  const bool designation = isDesignation(r.name);
  const auto name = r.name.empty() ? 0 : b.CreateString(r.name);
  const auto center = b.CreateSharedString("SUN");
  const auto frameName = b.CreateSharedString("ECLIPJ2000");
  const auto timeSystem = b.CreateSharedString("TDB");
  const auto epoch = b.CreateString(r.epoch);
  const auto ceuEpoch = r.ceuEpoch.empty() ? 0 : b.CreateString(r.ceuEpoch);
  const double q = r.aAu * (1.0 - r.e);
  // Earth MOID for a NEO (the only orbits that can be hazardous), and PHA.
  const bool neo = q < 1.3;
  const double moid = neo ? moidAu(conic(r.aAu, r.e, r.inc, r.node, r.w), earthOrbit(r.epoch)) : NAN;
  SBDBuilder sbd(b);
  sbd.add_NUMBER(uint32_t(r.number));
  if (name.o) { if (designation) sbd.add_DESIGNATION(name); else sbd.add_NAME(name); }
  sbd.add_ORBIT_CLASS(orbitClass(r.aAu, r.e));
  sbd.add_NEO(neo);
  if (neo) {
    sbd.add_EARTH_MOID(moid);
    sbd.add_PHA(moid <= moidPhaAu && r.hasH && r.h <= phaMaxH);
  }
  sbd.add_CENTER_NAME(center);
  sbd.add_REF_FRAME(frameName);
  sbd.add_TIME_SYSTEM(timeSystem);
  sbd.add_EPOCH(epoch);
  sbd.add_SEMI_MAJOR_AXIS(r.aAu * auKm);
  sbd.add_ECCENTRICITY(r.e);
  sbd.add_INCLINATION(r.inc);
  sbd.add_RA_OF_ASC_NODE(r.node);
  sbd.add_ARG_OF_PERICENTER(r.w);
  sbd.add_MEAN_ANOMALY(r.m);
  sbd.add_GM(gmSunKm3s2);
  if (r.hasH) sbd.add_ABSOLUTE_MAGNITUDE(r.h);
  if (r.hasG) sbd.add_SLOPE_PARAMETER(r.g);
  if (r.hasD && r.d > 0) sbd.add_DIAMETER(r.d);
  if (r.hasCeu) sbd.add_CEU(r.ceu);
  if (r.hasCeuRate) sbd.add_CEU_RATE(r.ceuRate);
  if (ceuEpoch.o) sbd.add_CEU_EPOCH(ceuEpoch);
  if (r.hasArc) sbd.add_ORBIT_ARC(r.arc);
  if (r.hasObs && r.obs >= 0) sbd.add_OBSERVATION_COUNT(uint32_t(r.obs));
  sbd.add_PROVENANCE(provenance);
  FinishSizePrefixedSBDBuffer(b, sbd.Finish());
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
  Largest largest;
};
bool survey(const GzipInput& gz, Survey& out) {
  Row row;
  std::vector<RankedRow> ranked;
  const bool ok = forEachLine(gz, [&](const char* line, size_t len) {
    if (len == 0) return;
    ++out.lines;
    if (!parseLine(line, len, row)) { ++out.skipped; return; }
    if (out.minEpoch.empty() || row.epoch < out.minEpoch) out.minEpoch = row.epoch;
    if (out.maxEpoch.empty() || row.epoch > out.maxEpoch) out.maxEpoch = row.epoch;
    ++out.rows;
    ++out.bands[band(row)];
    ranked.push_back({float(rankSizeKm(row)), uint32_t(row.number), row.hasD && row.d > 0});
  });
  if (ok) chooseLargest(ranked, out.largest);
  return ok;
}

// The storage meta of one lane: astorb-numbered (every numbered asteroid),
// astorb-largest-10pct (the largest tenth, $SBD) or astorb-groups (the two
// $EGP groups that list them). The record lanes' batch is the file's SHA-256
// (the same file twice is the same records). The groups carry the retrieval
// time, so a re-pull of the same file writes new group versions: their batch
// is the file's SHA-256 and that time, and reconcile "current" retires the
// versions it replaces (one pair of groups on the lane, never one per pull).
Json ingestMeta(const std::string& sourceSha, const std::string& peer, const char* lane = sourceName, int64_t retrieved = 0) {
  const bool groups = std::strcmp(lane, groupsSourceName) == 0;
  const bool largest = std::strcmp(lane, largestSourceName) == 0;
  const std::string batch = groups ? sourceSha + "@" + std::to_string(retrieved) : sourceSha;
  return {{"schema", groups ? "EGP.fbs" : "SBD.fbs"}, {"batch_id", batch}, {"provider_id", providerId},
          {"source_name", lane}, {"source_url", sourceUrl}, {"source_peer", peer},
          {"reconcile", "current"}, {"origin_id", "lowell.edu"}, {"origin_name", "Lowell Observatory astorb"},
          {"dataset_id", groups ? "lowell-astorb/groups" : largest ? "lowell-astorb/numbered-largest-10pct" : "lowell-astorb/numbered"},
          {"terms_url", "https://asteroid.lowell.edu/astorb/"}, {"citation", credit}, {"licence", licence}};
}

Json surveyReport(const Survey& s, const std::string& sourceSha, size_t gzLength, size_t recordBytes, int64_t retrieved) {
  return {{"records", s.rows}, {"lines", s.lines}, {"skipped_lines", s.skipped},
          {"bands", {{"H00-12", s.bands[0]}, {"H12-15", s.bands[1]}, {"H15-17", s.bands[2]}, {"H17-99", s.bands[3]}}},
          {"largest", {{"source_name", largestSourceName}, {"records", s.largest.count},
                       {"by_diameter", s.largest.measured}, {"by_absolute_magnitude", s.largest.count - s.largest.measured},
                       {"smallest_km", s.largest.smallestKm},
                       {"rank", "catalog (IRAS) diameter, else 1329 km / sqrt(0.14) x 10^(-H/5); largest first, ties by number; the first ceil(N/10)"}}},
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
// Every record of the largest tenth, in file (number) order.
template <class OnRecord>
bool forEachLargestRecord(const GzipInput& gz, const Largest& largest, flatbuffers::FlatBufferBuilder& b, OnRecord onRecord) {
  Row row;
  return forEachLine(gz, [&](const char* line, size_t len) {
    if (len == 0 || !parseLine(line, len, row) || !largest.has(row.number)) return;
    buildRecord(row, b);
    onRecord(b.GetBufferPointer(), b.GetSize());
  });
}

// RFC 3339 UTC with fixed milliseconds, from Unix milliseconds.
std::string rfc3339Ms(int64_t ms) {
  int64_t days = ms / 86400000, rest = ms % 86400000;
  if (rest < 0) { rest += 86400000; --days; }
  // civil_from_days (H. Hinnant)
  days += 719468;
  const int64_t era = (days >= 0 ? days : days - 146096) / 146097;
  const int64_t doe = days - era * 146097;
  const int64_t yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
  const int64_t doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
  const int64_t mp = (5 * doy + 2) / 153;
  const int64_t d = doy - (153 * mp + 2) / 5 + 1, m = mp < 10 ? mp + 3 : mp - 9, y = yoe + era * 400 + (m <= 2);
  char out[32];
  std::snprintf(out, sizeof out, "%04lld-%02lld-%02lldT%02lld:%02lld:%02lld.%03lldZ", (long long)y, (long long)m, (long long)d,
                (long long)(rest / 3600000), (long long)(rest / 60000 % 60), (long long)(rest / 1000 % 60), (long long)(rest % 1000));
  return out;
}

// The catalog listing: two size-prefixed $EGP groups, one per lane, each a
// live query (QUERY_LIVE: the query is the definition, there is no member
// list) naming its lane the way an SDN data query names it, with its count,
// cadence, source and licence.
std::vector<uint8_t> groupRecords(const Survey& s, const std::string& sourceSha, int64_t retrieved) {
  std::vector<uint8_t> stream;
  const std::string at = rfc3339Ms(retrieved);
  const auto one = [&](const char* id, const char* name, const char* description, const char* lane, size_t count) {
    flatbuffers::FlatBufferBuilder b(1024);
    // Sorted and deduplicated (EGP tag grammar).
    const std::string tagText[] = {std::string("cadence:") + cadence, "class:query", "environment:space",
                                   "provisioner:lowell-astorb", "regime:heliocentric", "schema:sbd",
                                   std::string("source:") + lane};
    std::vector<flatbuffers::Offset<flatbuffers::String>> tags;
    for (const auto& t : tagText) tags.push_back(b.CreateString(t));
    const std::string queryText = Json({{"schema", "SBD.fbs"}, {"provider_id", providerId}, {"source_name", lane}}).dump();
    const auto provenance = CreateEGPProvenanceDirect(b, "Lowell Observatory", "astorb.dat", nullptr, sourceUrl, nullptr, at.c_str(),
                                                      sourceSha.c_str(), licence, credit, nullptr);
    const auto query = CreateEGPQueryDirect(b, "sdn-data-query", queryText.c_str(), at.c_str(), uint32_t(count), s.maxEpoch.c_str());
    std::vector<flatbuffers::Offset<EGPProvenance>> provenances = {provenance};
    const auto group = CreateEGPDirect(b, id, name, description, &tags, egpMembershipMode::QUERY_LIVE, nullptr, query, at.c_str(),
                                       at.c_str(), &provenances, nullptr);
    FinishSizePrefixedEGPBuffer(b, group);
    stream.insert(stream.end(), b.GetBufferPointer(), b.GetBufferPointer() + b.GetSize());
  };
  one("lowell-astorb/numbered", "Asteroids (numbered)",
      "Every numbered asteroid in Lowell Observatory's astorb.dat as $SBD small-body records (osculating heliocentric "
      "elements, H, G, diameter, orbit class and quality), refreshed every 72 h.",
      sourceName, s.rows);
  one("lowell-astorb/numbered-largest-10pct", "Asteroids (numbered, largest 10%)",
      "The largest tenth of the numbered asteroids, the subset drawn by default: ranked by the catalog (IRAS) diameter, "
      "else by the diameter from H at geometric albedo 0.14 (D = 1329 km / sqrt(0.14) x 10^(-H/5)), largest first, ties "
      "by number; the first ceil(N/10).",
      largestSourceName, s.largest.count);
  return stream;
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
