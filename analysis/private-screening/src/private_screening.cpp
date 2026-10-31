#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <limits>
#include <map>
#include <random>
#include <string>
#include <unordered_map>
#include <vector>

// Decoy orbits for private conjunction screening, and the experiment that
// measures how well they hide a real orbit.
//
// An owner screening a satellite that the public catalog lacks submits N
// candidate orbits: one real, N-1 decoys, and only its key says which. An
// adversary who learns all N histories finds the real one with probability at
// most e^(2 eps)/N, where eps bounds |ln p/q| between the adversary's prior p
// for real orbits and the decoy distribution q. These methods generate
// decoys and measure how far a strong distinguisher gets on real histories.
//
// decoys       population histories (SGP4 mean elements, one per object) ->
//              decoy histories over the same span, one generator per call:
//                independent     n, e, i from three different objects, B* 0,
//                                uniform angles, SGP4 secular motion only;
//                rotated         one object's history, node and mean anomaly
//                                shifted by uniform constants;
//                resampled       a new history: orbit size and shape from one
//                                object, offset by the (a, e, i) difference
//                                between a random object and its nearest
//                                catalog neighbour; its decay rate following
//                                the population's daily drag common mode; its
//                                manoeuvre steps at random times; its cadence
//                                and per-element fit noise resampled;
//                                along-track phase from SGP4's secular rates;
//                chained         a new history from the same offset start:
//                                each set is the previous one advanced by
//                                SGP4's secular rates plus the object's real
//                                consecutive-set changes in mean elements (in
//                                order), with fresh dither on each published
//                                set;
//                aligned         chained, with the changes in the donor's own
//                                time order and epochs;
//                fleet           the target's own history, node shifted by a
//                                uniform constant and epochs by up to half a
//                                period: a virtual fleet of the hidden
//                                satellite itself, which the public catalog
//                                does not hold.
// features     rotation-invariant features of each history, real or decoy:
//                gp    from its element sets (orbit, decay, noise, steps,
//                      cadence, B*, node-rate residual, agreement between
//                      consecutive sets);
//                ffm  from daily ephemeris windows (orbit-averaged elements
//                      per window, the jump between consecutive windows);
//              both views add the correlation of daily decay with the drag
//              common mode, the best lagged correlation of the history's
//              changes with those of the 30 most similar public objects (a
//              replayed sequence), and the distance to the nearest public
//              object (the catalog is the real histories, less the target).
// distinguish  real versus decoy by a gradient-boosted tree classifier,
//              cross-validated by target: AUC, a 95 % lower bound on eps,
//              P(the real history scores highest of N) and N_eff = 1/P.

namespace {

constexpr double kPi = 3.14159265358979323846;
constexpr double kDeg = kPi / 180.0;
constexpr double kDay = 86400.0;
constexpr double kMuWgs72 = 398600.8;    // km^3/s^2, SGP4's constant
constexpr double kMu = 398600.4418;      // km^3/s^2, FFM states
constexpr double kRe = 6378.1363;        // km
constexpr double kJ2 = 1.08262668e-3;
constexpr double kSgp4EpochFromUnixDays = 7306.0;  // days from 1949-12-31 00:00 to 1970-01-01

// SGP4 (the SGP4/SDP4 base foundation/sgp4-str3: WGS-72, AFSPC mode). sgp4_init: a set from its mean elements
// (radians; the Kozai mean motion in rad/min, as element sets carry it), the epoch in days from 1949 December 31 0h UT
// taken as one Julian date; initialization also evaluates the set at its epoch and refuses what SGP4 refuses there.
// sgp4_eval: the TEME state (km, km/s) at `minutes` from the epoch, false where SGP4 refuses the point.
bool sgp4_init(double ds50, double bstar, double e, double argp, double inc, double ma, double no_kozai, double node,
               sdnap::Sat& sat) {
  sdnap::Elements el{};
  el.epoch_jd_whole = ds50 + sdnap::kJd1950;
  el.xno = no_kozai;
  el.eo = e;
  el.xincl = inc;
  el.xnodeo = node;
  el.omegao = argp;
  el.xmo = ma;
  el.bstar = bstar;
  double r[3], v[3];
  return sdnap::sat_init(el, sdnap::gravity_wgs72(), sat, sdnap::Sgp4Mode::kAfspc) == sdnap::kPropOk &&
         sdnap::sat_propagate(sat, nullptr, 0.0, r, v) == sdnap::kPropOk;
}
bool sgp4_eval(const sdnap::Sat& sat, double minutes, double r[3], double v[3]) {
  return sdnap::sat_propagate(sat, nullptr, minutes, r, v) == sdnap::kPropOk;
}
const double kNaN = std::numeric_limits<double>::quiet_NaN();

int fail(const char* code, const std::string& message) {
  plugin_set_error(code, message.c_str());
  return 1;
}
const plugin_input_frame_t* input(const char* port) {
  const int32_t index = plugin_find_input_index(port, 0);
  return index >= 0 ? plugin_get_input_frame(static_cast<uint32_t>(index)) : nullptr;
}
// A size-prefixed or plain root, verified.
template <typename T>
const T* root(const plugin_input_frame_t* f, const char* ident) {
  if (!f || !f->payload || f->payload_length < 8) return nullptr;
  const uint8_t* p = f->payload;
  const size_t n = f->payload_length;
  flatbuffers::Verifier::Options options;
  options.max_tables = 100000000;
  options.max_depth = 128;
  if (flatbuffers::BufferHasIdentifier(p, ident, true)) {
    flatbuffers::Verifier v(p, n, options);
    return v.VerifySizePrefixedBuffer<T>(ident) ? flatbuffers::GetSizePrefixedRoot<T>(p) : nullptr;
  }
  flatbuffers::Verifier v(p, n, options);
  return flatbuffers::BufferHasIdentifier(p, ident, false) && v.VerifyBuffer<T>(ident) ? flatbuffers::GetRoot<T>(p) : nullptr;
}
std::string text(const flatbuffers::String* s) { return s ? s->str() : std::string(); }
int emit_lfv(const char* port, flatbuffers::FlatBufferBuilder& fbb, flatbuffers::Offset<LFV> root) {
  fbb.Finish(root, "$LFV");
  return plugin_push_output_ex(port, "LFV.fbs", "$LFV", PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, "LFV", 0, 0,
                               fbb.GetBufferPointer(), static_cast<uint32_t>(fbb.GetSize())) < 0
             ? fail("output-failed", std::string("could not push ") + port)
             : 0;
}
// Non-finite values are "not computable": NaN on the wire.
double finite_or_nan(double x) { return std::isfinite(x) ? x : std::numeric_limits<double>::quiet_NaN(); }

// ── epochs: ISO 8601 UTC with nanosecond digits; a unix-seconds double of this era round-trips exactly ──
int64_t days_from_civil(int64_t y, unsigned m, unsigned d) {
  y -= m <= 2;
  const int64_t era = (y >= 0 ? y : y - 399) / 400;
  const unsigned yoe = static_cast<unsigned>(y - era * 400);
  const unsigned doy = (153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1;
  const unsigned doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
  return era * 146097 + static_cast<int64_t>(doe) - 719468;
}
void civil_from_days(int64_t z, int64_t* y, unsigned* m, unsigned* d) {
  z += 719468;
  const int64_t era = (z >= 0 ? z : z - 146096) / 146097;
  const unsigned doe = static_cast<unsigned>(z - era * 146097);
  const unsigned yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
  const unsigned doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
  const unsigned mp = (5 * doy + 2) / 153;
  *d = doy - (153 * mp + 2) / 5 + 1;
  *m = mp < 10 ? mp + 3 : mp - 9;
  *y = static_cast<int64_t>(yoe) + era * 400 + (*m <= 2);
}
// unix seconds from "YYYY-MM-DDTHH:MM:SS[.f...][Z]"; NaN when it does not parse.
double parse_epoch(const flatbuffers::String* s) {
  if (!s) return kNaN;
  const std::string t = s->str();
  int y, mo, d, h, mi;
  int used = 0;
  if (std::sscanf(t.c_str(), "%d-%d-%dT%d:%d:%n", &y, &mo, &d, &h, &mi, &used) != 5 || used == 0) return kNaN;
  char* end = nullptr;
  const double sec = std::strtod(t.c_str() + used, &end);
  if (end == t.c_str() + used || (*end && !(end[0] == 'Z' && !end[1]))) return kNaN;
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h < 0 || h > 23 || mi < 0 || mi > 59 || !(sec >= 0 && sec < 61)) return kNaN;
  const double base = static_cast<double>(days_from_civil(y, mo, d) * 86400 + h * 3600 + mi * 60);
  return base + sec;
}
std::string format_epoch(double t) {
  int64_t whole = static_cast<int64_t>(std::floor(t));
  char frac[32];
  std::snprintf(frac, sizeof frac, "%.9f", t - static_cast<double>(whole));
  if (frac[0] == '1') ++whole, std::snprintf(frac, sizeof frac, "%.9f", 0.0);
  const int64_t days = (whole >= 0 ? whole : whole - 86399) / 86400, rest = whole - days * 86400;
  int64_t y;
  unsigned m, d;
  civil_from_days(days, &y, &m, &d);
  char buf[64];
  std::snprintf(buf, sizeof buf, "%04lld-%02u-%02uT%02lld:%02lld:%02lld%sZ", static_cast<long long>(y), m, d,
                static_cast<long long>(rest / 3600), static_cast<long long>(rest / 60 % 60), static_cast<long long>(rest % 60), frac + 1);
  return buf;
}

// ── statistics ──
double median(std::vector<double> v) {
  v.erase(std::remove_if(v.begin(), v.end(), [](double x) { return !std::isfinite(x); }), v.end());
  if (v.empty()) return kNaN;
  const size_t h = v.size() / 2;
  std::nth_element(v.begin(), v.begin() + h, v.end());
  const double upper = v[h];
  if (v.size() % 2) return upper;
  return 0.5 * (upper + *std::max_element(v.begin(), v.begin() + h));
}
double robust_sigma(const std::vector<double>& v) {
  const double m = median(v);
  std::vector<double> d;
  for (double x : v)
    if (std::isfinite(x)) d.push_back(std::fabs(x - m));
  return 1.4826 * median(d);
}
struct Line {
  double slope = kNaN, intercept = kNaN;
  double at(double x) const { return intercept + slope * x; }
};
Line theil_sen(const std::vector<double>& x, const std::vector<double>& y) {
  std::vector<double> s;
  for (size_t i = 0; i < x.size(); ++i)
    for (size_t j = i + 1; j < x.size(); ++j)
      if (x[j] != x[i]) s.push_back((y[j] - y[i]) / (x[j] - x[i]));
  Line l;
  if (s.empty()) return l;
  l.slope = median(s);
  std::vector<double> r(x.size());
  for (size_t i = 0; i < x.size(); ++i) r[i] = y[i] - l.slope * x[i];
  l.intercept = median(r);
  return l;
}
double correlation(const std::vector<double>& x, const std::vector<double>& y, int min_count) {
  double sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
  int n = 0;
  for (size_t k = 0; k < x.size() && k < y.size(); ++k) {
    if (!std::isfinite(x[k]) || !std::isfinite(y[k])) continue;
    sx += x[k], sy += y[k], sxx += x[k] * x[k], syy += y[k] * y[k], sxy += x[k] * y[k], ++n;
  }
  if (n < min_count) return kNaN;
  const double vx = sxx - sx * sx / n, vy = syy - sy * sy / n;
  return vx > 0 && vy > 0 ? (sxy - sx * sy / n) / std::sqrt(vx * vy) : kNaN;
}
std::vector<double> unwrap_deg(std::vector<double> a) {
  for (size_t k = 1; k < a.size(); ++k) a[k] = a[k - 1] + std::remainder(a[k] - a[k - 1], 360.0);
  return a;
}
double wrap_deg(double a) {
  a = std::fmod(a, 360.0);
  return a < 0 ? a + 360.0 : a;
}

// Deterministic draws, identical in every runtime (no library distributions).
struct Rng {
  std::mt19937_64 g;
  explicit Rng(uint64_t seed) : g(seed) {}
  double uniform() { return static_cast<double>(g() >> 11) * 0x1.0p-53; }
  double normal() {
    const double u = 1.0 - uniform(), v = uniform();
    return std::sqrt(-2.0 * std::log(u)) * std::cos(2.0 * kPi * v);
  }
  size_t index(size_t n) { return static_cast<size_t>(uniform() * n) % n; }
  template <class T>
  const T& pick(const std::vector<T>& v) { return v[index(v.size())]; }
};
uint64_t mix(uint64_t x) {
  x += 0x9e3779b97f4a7c15ULL;
  x = (x ^ (x >> 30)) * 0xbf58476d1ce4e5b9ULL;
  x = (x ^ (x >> 27)) * 0x94d049bb133111ebULL;
  return x ^ (x >> 31);
}
uint64_t hash_text(const std::string& s) {
  uint64_t h = 1469598103934665603ULL;
  for (unsigned char c : s) h = (h ^ c) * 1099511628211ULL;
  return h;
}

// ── histories ──
struct Set {
  double t, n, e, i, raan, argp, ma, bstar;  // unix s; rev/day; deg; 1/earth radii
};
struct Window {   // one daily ephemeris window (ffm view), GCRF km, km/s
  double t;
  std::vector<std::array<double, 7>> samples;   // t, r, v
  std::array<double, 7> end{};                  // state at the next window's start
  bool has_end = false;
};
struct History {
  std::string id, target, role, generator, cls;
  std::vector<Set> sets;
  std::vector<Window> windows;
};
// Histories arrive as $LFV rows: SOURCE_ID the history's id, TARGET (empty =
// the id), ROLE (Unlabelled reads as real, the old default), GENERATOR,
// CLASS_LABEL, and ELEMENT_SETS, the $OMM element sets (EPOCH, MEAN_MOTION,
// ECCENTRICITY, INCLINATION, RA_OF_ASC_NODE, ARG_OF_PERICENTER, MEAN_ANOMALY,
// BSTAR). Daily ephemeris windows (ffm view) arrive as one $OEM: a block per
// window, OBJECT.OBJECT_ID the history's id, START_TIME the window start, the
// lines up to USEABLE_STOP_TIME the samples (GCRF km, km/s), and a line at
// STOP_TIME after USEABLE_STOP_TIME the state at the next window's start.
const char* role_name(lfvRole r) { return r == lfvRole::Decoy ? "decoy" : "real"; }
lfvRole role_of(const std::string& r) { return r == "decoy" ? lfvRole::Decoy : r == "real" ? lfvRole::Real : lfvRole::Unlabelled; }

bool read_histories(const LFV* lfv, const OEM* oem, std::vector<History>* out, std::string* error) {
  if (!lfv || !lfv->ROWS()) {
    *error = "expected an $LFV with ROWS";
    return false;
  }
  std::unordered_map<std::string, size_t> where;
  for (const LFVRow* o : *lfv->ROWS()) {
    History h;
    h.id = text(o->SOURCE_ID());
    h.target = text(o->TARGET());
    if (h.target.empty()) h.target = h.id;
    h.role = role_name(o->ROLE());
    h.generator = text(o->GENERATOR());
    h.cls = text(o->CLASS_LABEL());
    if (h.id.empty()) {
      *error = "every row needs a SOURCE_ID";
      return false;
    }
    if (o->ELEMENT_SETS()) {
      for (const OMM* m : *o->ELEMENT_SETS()) {
        const double v[8] = {parse_epoch(m->EPOCH()), m->MEAN_MOTION(), m->ECCENTRICITY(), m->INCLINATION(),
                             m->RA_OF_ASC_NODE(), m->ARG_OF_PERICENTER(), m->MEAN_ANOMALY(), m->BSTAR()};
        Set s{v[0], v[1], v[2], v[3], v[4], v[5], v[6], v[7]};
        if (std::all_of(v, v + 8, [](double x) { return std::isfinite(x); }) && s.n > 0) h.sets.push_back(s);
      }
      std::sort(h.sets.begin(), h.sets.end(), [](const Set& a, const Set& b) { return a.t < b.t; });
    }
    where.emplace(h.id, out->size());
    out->push_back(std::move(h));
  }
  if (oem && oem->EPHEMERIS_DATA_BLOCK()) {
    std::vector<bool> touched(out->size(), false);
    for (const ephemerisDataBlock* b : *oem->EPHEMERIS_DATA_BLOCK()) {
      const auto it = b && b->OBJECT() ? where.find(text(b->OBJECT()->OBJECT_ID())) : where.end();
      if (it == where.end()) continue;
      Window win;
      win.t = parse_epoch(b->START_TIME());
      const double usable_stop = b->USEABLE_STOP_TIME() ? parse_epoch(b->USEABLE_STOP_TIME()) : INFINITY;
      if (b->EPHEMERIS_DATA_LINES())
        for (const ephemerisDataLine* l : *b->EPHEMERIS_DATA_LINES()) {
          std::array<double, 7> st{parse_epoch(l->EPOCH()), l->X(), l->Y(), l->Z(), l->X_DOT(), l->Y_DOT(), l->Z_DOT()};
          const bool ok = std::all_of(st.begin(), st.end(), [](double x) { return std::isfinite(x); });
          if (std::isfinite(st[0]) && st[0] > usable_stop) win.has_end = ok, win.end = st;
          else if (ok) win.samples.push_back(st);
        }
      if (std::isfinite(win.t) && !win.samples.empty()) (*out)[it->second].windows.push_back(win), touched[it->second] = true;
    }
    for (size_t k = 0; k < out->size(); ++k)
      if (touched[k])
        std::sort((*out)[k].windows.begin(), (*out)[k].windows.end(), [](const Window& a, const Window& b) { return a.t < b.t; });
  }
  return true;
}

// Histories as $LFV rows with their element sets as $OMM.
flatbuffers::Offset<flatbuffers::Vector<flatbuffers::Offset<LFVRow>>> write_histories(flatbuffers::FlatBufferBuilder& fbb,
                                                                                       const std::vector<History>& list) {
  std::vector<flatbuffers::Offset<LFVRow>> rows;
  rows.reserve(list.size());
  for (const History& h : list) {
    std::vector<flatbuffers::Offset<OMM>> sets;
    sets.reserve(h.sets.size());
    for (const Set& e : h.sets) {
      const auto epoch = fbb.CreateString(format_epoch(e.t));
      OMMBuilder m(fbb);
      m.add_EPOCH(epoch);
      m.add_MEAN_MOTION(e.n);
      m.add_ECCENTRICITY(e.e);
      m.add_INCLINATION(e.i);
      m.add_RA_OF_ASC_NODE(e.raan);
      m.add_ARG_OF_PERICENTER(e.argp);
      m.add_MEAN_ANOMALY(e.ma);
      m.add_BSTAR(e.bstar);
      sets.push_back(m.Finish());
    }
    rows.push_back(CreateLFVRowDirect(fbb, h.id.c_str(), h.target.c_str(), role_of(h.role), h.generator.c_str(),
                                      h.cls.empty() ? nullptr : h.cls.c_str(), nullptr, kNaN, &sets));
  }
  return fbb.CreateVector(rows);
}

// ── SGP4 (sgp4_init above: foundation/sgp4-str3, WGS-72, AFSPC mode) ──
bool init_set(const Set& s, sdnap::Sat* rec) {
  return sgp4_init(s.t / kDay + kSgp4EpochFromUnixDays, s.bstar, s.e,
                   s.argp * kDeg, s.i * kDeg, s.ma * kDeg, s.n * 2.0 * kPi / 1440.0, s.raan * kDeg, *rec);
}
double mean_a_km(const sdnap::Sat& rec) {
  const double n = rec.xnodp / 60.0;
  return std::cbrt(kMuWgs72 / (n * n));
}
constexpr double kRatePerDay = 1440.0 / kDeg;   // rad/min -> deg/day

// ── geometry ──
void cross(const double* a, const double* b, double* c) {
  c[0] = a[1] * b[2] - a[2] * b[1];
  c[1] = a[2] * b[0] - a[0] * b[2];
  c[2] = a[0] * b[1] - a[1] * b[0];
}
double dot(const double* a, const double* b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
double norm(const double* a) { return std::sqrt(dot(a, a)); }
// d in the radial, transverse, normal axes of (r, v).
void rtn(const double* r, const double* v, const double* d, double* out) {
  double n[3], t[3], u[3];
  cross(r, v, n);
  const double rn = norm(r), nn = norm(n);
  for (int k = 0; k < 3; ++k) u[k] = r[k] / rn, n[k] /= nn;
  cross(n, u, t);
  out[0] = dot(d, u), out[1] = dot(d, t), out[2] = dot(d, n);
}
struct Osculating {
  double a, ex, ey, ez, i, raan;
};
Osculating osculating(const double* r, const double* v) {
  double h[3];
  cross(r, v, h);
  const double rn = norm(r), v2 = dot(v, v), rv = dot(r, v), hn = norm(h);
  Osculating o;
  o.a = 1.0 / (2.0 / rn - v2 / kMu);
  o.ex = ((v2 - kMu / rn) * r[0] - rv * v[0]) / kMu;
  o.ey = ((v2 - kMu / rn) * r[1] - rv * v[1]) / kMu;
  o.ez = ((v2 - kMu / rn) * r[2] - rv * v[2]) / kMu;
  o.i = std::acos(std::clamp(h[2] / hn, -1.0, 1.0)) / kDeg;
  o.raan = wrap_deg(std::atan2(h[0], -h[1]) / kDeg);
  return o;
}
// J2 secular node rate, deg/day.
double j2_node_rate(double a, double e, double i_deg) {
  const double n = std::sqrt(kMu / (a * a * a)), p = a * (1 - e * e);
  return -1.5 * n * kJ2 * (kRe / p) * (kRe / p) * std::cos(i_deg * kDeg) * kDay / kDeg;
}

// ── tracks: a history as orbit series (per element set, or per window) ──
struct Track {
  std::vector<double> t, a, e, i, raan;  // unix s, km, -, deg, deg
  std::vector<double> node_rate;         // expected secular node rate per point, deg/day
};
Track gp_track(const History& h, double w0, double w1, std::vector<sdnap::Sat>* recs) {
  Track tr;
  for (const Set& s : h.sets) {
    if (s.t < w0 || s.t >= w1) continue;
    sdnap::Sat rec;
    if (!init_set(s, &rec)) continue;
    tr.t.push_back(s.t), tr.a.push_back(mean_a_km(rec)), tr.e.push_back(s.e), tr.i.push_back(s.i);
    tr.raan.push_back(s.raan), tr.node_rate.push_back(rec.xnodot * kRatePerDay);
    if (recs) recs->push_back(rec);
  }
  return tr;
}
Track ffm_track(const History& h, double w0, double w1) {
  Track tr;
  for (const Window& w : h.windows) {
    if (w.t < w0 || w.t >= w1) continue;
    double a = 0, ex = 0, ey = 0, ez = 0, i = 0, c = 0, s = 0;
    for (const auto& st : w.samples) {
      const Osculating o = osculating(&st[1], &st[4]);
      a += o.a, ex += o.ex, ey += o.ey, ez += o.ez, i += o.i;
      c += std::cos(o.raan * kDeg), s += std::sin(o.raan * kDeg);
    }
    const double m = static_cast<double>(w.samples.size());
    a /= m, ex /= m, ey /= m, ez /= m, i /= m;
    const double e = std::sqrt(ex * ex + ey * ey + ez * ez);
    tr.t.push_back(w.t), tr.a.push_back(a), tr.e.push_back(e), tr.i.push_back(i);
    tr.raan.push_back(wrap_deg(std::atan2(s, c) / kDeg)), tr.node_rate.push_back(j2_node_rate(a, e, i));
  }
  return tr;
}
// Median of y per UTC day of [w0, w0 + days); NaN for a day without points.
std::vector<double> daily(const Track& tr, const std::vector<double>& y, double w0, int days) {
  std::vector<std::vector<double>> by(days);
  for (size_t k = 0; k < tr.t.size(); ++k) {
    const int d = static_cast<int>(std::floor((tr.t[k] - w0) / kDay));
    if (d >= 0 && d < days) by[d].push_back(y[k]);
  }
  std::vector<double> out(days);
  for (int d = 0; d < days; ++d) out[d] = median(by[d]);
  return out;
}
std::vector<double> differences(const std::vector<double>& y) {
  std::vector<double> d;
  for (size_t k = 1; k < y.size(); ++k) d.push_back(y[k] - y[k - 1]);
  return d;
}

// Drag common mode: per 100 km altitude band, the median over decaying real
// objects of each day's decay relative to the object's median daily decay
// (space weather shows as the same days decaying faster for every object).
struct CommonMode {
  static constexpr double kBandKm = 100.0, kLowestKm = 150.0;
  std::vector<std::vector<double>> profile;  // per band, days - 1 values, mean 1; empty without enough objects
  std::vector<int> objects;
  int band(double alt) const {
    const int b = static_cast<int>(std::floor((alt - kLowestKm) / kBandKm));
    return std::clamp(b, 0, static_cast<int>(profile.size()) - 1);
  }
  const std::vector<double>* at(double alt) const {
    const int b = band(alt);
    for (int d = 0; d < static_cast<int>(profile.size()); ++d)
      for (int s : {b - d, b + d})
        if (s >= 0 && s < static_cast<int>(profile.size()) && !profile[s].empty()) return &profile[s];
    return nullptr;
  }
};
CommonMode common_mode(const std::vector<std::vector<double>>& daily_a, int days) {
  CommonMode cm;
  cm.profile.assign(19, {});
  cm.objects.assign(19, 0);
  std::vector<std::vector<std::vector<double>>> rel(19, std::vector<std::vector<double>>(std::max(days - 1, 0)));
  for (const auto& a : daily_a) {
    const std::vector<double> d = differences(a);
    int defined = 0;
    for (double x : d) defined += std::isfinite(x);
    const double m = median(d);
    double raise = 0;
    for (double x : d)
      if (std::isfinite(x)) raise = std::max(raise, x);
    if (defined < 0.6 * (days - 1) || !(m < -0.01) || raise > 0.05) continue;
    const int b = cm.band(median(a) - kRe);
    ++cm.objects[b];
    for (size_t k = 0; k < d.size(); ++k)
      if (std::isfinite(d[k])) rel[b][k].push_back(d[k] / m);
  }
  for (size_t b = 0; b < rel.size(); ++b) {
    if (cm.objects[b] < 10) continue;
    std::vector<double> p(rel[b].size());
    double sum = 0;
    int n = 0;
    for (size_t k = 0; k < p.size(); ++k) {
      p[k] = rel[b][k].size() >= 5 ? median(rel[b][k]) : kNaN;
      if (std::isfinite(p[k])) sum += p[k], ++n;
    }
    if (n < 0.6 * p.size()) continue;
    for (double& x : p) x = std::isfinite(x) ? x / (sum / n) : 1.0;
    cm.profile[b] = p;
  }
  return cm;
}

// Catalog match: daily a, i, e; distance in units of 1 km, 0.01 deg, 1e-4.
struct Signature {
  std::vector<double> a, i, e;
  double a_mean = kNaN, i_mean = kNaN;
};
Signature signature(const Track& tr, double w0, int days) {
  Signature s;
  s.a = daily(tr, tr.a, w0, days), s.i = daily(tr, tr.i, w0, days), s.e = daily(tr, tr.e, w0, days);
  s.a_mean = median(s.a), s.i_mean = median(s.i);
  return s;
}
double distance(const Signature& x, const Signature& y) {
  double sum = 0;
  int n = 0;
  const int days = static_cast<int>(x.a.size());
  for (int d = 0; d < days; ++d) {
    if (!std::isfinite(x.a[d]) || !std::isfinite(y.a[d])) continue;
    const double da = x.a[d] - y.a[d], di = (x.i[d] - y.i[d]) / 0.01, de = (x.e[d] - y.e[d]) / 1e-4;
    sum += da * da + di * di + de * de, ++n;
  }
  if (n < (days + 1) / 2) return kNaN;
  return std::sqrt(sum / n);
}
// Largest |correlation| of x with y at any cyclic lag of y: a history that
// replays a public object's sequence of changes, from any starting point,
// correlates with it near 1.
double lagged_match(const std::vector<double>& x, const std::vector<double>& y) {
  const size_t m = std::min(x.size(), y.size());
  if (m < 6) return kNaN;
  double best = 0;
  for (size_t lag = 0; lag < y.size(); ++lag) {
    double sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
    for (size_t k = 0; k < m; ++k) {
      const double a = x[k], b = y[(lag + k) % y.size()];
      sx += a, sy += b, sxx += a * a, syy += b * b, sxy += a * b;
    }
    const double vx = sxx - sx * sx / m, vy = syy - sy * sy / m;
    if (vx > 0 && vy > 0) best = std::max(best, std::fabs(sxy - sx * sy / m) / std::sqrt(vx * vy));
  }
  return best;
}
struct Catalog {
  std::vector<Signature> sigs;
  std::vector<std::vector<double>> seqs;   // per object: its sequence of changes
  std::vector<std::string> ids;
  std::vector<size_t> order;   // by a_mean
  void index() {
    order.clear();
    for (size_t k = 0; k < sigs.size(); ++k)
      if (std::isfinite(sigs[k].a_mean)) order.push_back(k);
    std::sort(order.begin(), order.end(), [&](size_t p, size_t q) { return sigs[p].a_mean < sigs[q].a_mean; });
  }
  // Nearest object other than `exclude`; scans outward in mean a, stopping
  // once the mean-a gap alone exceeds the best distance by 2 km.
  double nearest(const Signature& s, const std::string& exclude, size_t* who = nullptr) const {
    if (!std::isfinite(s.a_mean) || order.empty()) return kNaN;
    const auto mid = std::lower_bound(order.begin(), order.end(), s.a_mean,
                                      [&](size_t k, double v) { return sigs[k].a_mean < v; }) - order.begin();
    double best = std::numeric_limits<double>::infinity();
    for (long lo = mid - 1, hi = mid; lo >= 0 || hi < static_cast<long>(order.size());) {
      const double glo = lo >= 0 ? s.a_mean - sigs[order[lo]].a_mean : INFINITY;
      const double ghi = hi < static_cast<long>(order.size()) ? sigs[order[hi]].a_mean - s.a_mean : INFINITY;
      const bool take_lo = glo <= ghi;
      const double gap = take_lo ? glo : ghi;
      if (gap > best + 2.0) break;
      const size_t k = order[take_lo ? lo-- : hi++];
      if (ids[k] == exclude) continue;
      const double d = distance(s, sigs[k]);
      if (d < best) {
        best = d;
        if (who) *who = k;
      }
    }
    return std::isfinite(best) ? best : kNaN;
  }
  // Best lagged match against the 30 objects nearest in mean a and i.
  double sequence_match(const Signature& s, const std::vector<double>& seq, const std::string& exclude) const {
    if (!std::isfinite(s.a_mean) || !std::isfinite(s.i_mean)) return kNaN;
    std::vector<std::pair<double, size_t>> near;
    for (size_t k = 0; k < sigs.size(); ++k) {
      if (ids[k] == exclude || !std::isfinite(sigs[k].a_mean)) continue;
      const double da = (sigs[k].a_mean - s.a_mean) / 25.0, di = sigs[k].i_mean - s.i_mean;
      near.push_back({da * da + di * di, k});
    }
    const size_t count = std::min<size_t>(near.size(), 30);
    std::partial_sort(near.begin(), near.begin() + count, near.end());
    double best = kNaN;
    for (size_t j = 0; j < count; ++j) {
      const double m = lagged_match(seq, seqs[near[j].second]);
      if (std::isfinite(m)) best = std::isfinite(best) ? std::max(best, m) : m;
    }
    return best;
  }
};

// ── features ──
struct Core {   // shared by both views
  double a, e, i, decay, a_scatter, a_max_step, steps_per_day, e_scatter, i_drift, i_scatter, node_residual;
};
Core core_features(const Track& tr, double span_days) {
  Core c{};
  std::vector<double> x(tr.t.size());
  for (size_t k = 0; k < x.size(); ++k) x[k] = (tr.t[k] - tr.t.front()) / kDay;
  c.a = median(tr.a), c.e = median(tr.e), c.i = median(tr.i);
  const Line la = theil_sen(x, tr.a), li = theil_sen(x, tr.i);
  c.decay = la.slope, c.i_drift = li.slope;
  std::vector<double> ra, ri;
  for (size_t k = 0; k < x.size(); ++k) ra.push_back(tr.a[k] - la.at(x[k])), ri.push_back(tr.i[k] - li.at(x[k]));
  c.a_scatter = robust_sigma(ra), c.i_scatter = robust_sigma(ri), c.e_scatter = robust_sigma(tr.e);
  std::vector<double> steps;
  for (size_t k = 1; k < x.size(); ++k) steps.push_back(tr.a[k] - tr.a[k - 1] - la.slope * (x[k] - x[k - 1]));
  const double sig = robust_sigma(steps), floor = std::max(6.0 * sig, 0.05);
  c.a_max_step = 0;
  int count = 0;
  for (double s : steps) {
    c.a_max_step = std::max(c.a_max_step, std::fabs(s));
    count += std::fabs(s) > floor;
  }
  c.steps_per_day = count / span_days;
  const Line lr = theil_sen(x, unwrap_deg(tr.raan));
  c.node_residual = lr.slope - median(tr.node_rate);
  return c;
}
// A function, not a global: the module runs no static constructors.
std::vector<std::string> core_names() {
  return {"aKm", "e", "iDeg", "decayKmPerDay", "aScatterKm", "aMaxStepKm", "stepsPerDay", "eScatter",
          "iDriftDegPerDay", "iScatterDeg", "nodeRateResidualDegPerDay"};
}
void push_core(const Core& c, std::vector<double>* x) {
  for (double v : {c.a, c.e, c.i, c.decay, c.a_scatter, c.a_max_step, c.steps_per_day, c.e_scatter, c.i_drift,
                   c.i_scatter, c.node_residual})
    x->push_back(v);
}

// Consecutive element sets: set k propagated to set k+1's epoch minus set
// k+1, in the propagated state's RTN axes (position km, velocity km/s), with
// the interval and set k+1's B*.
struct Link {
  double dt, d[6], bstar;
};
std::vector<Link> links(const std::vector<sdnap::Sat>& recs, const Track& tr) {
  std::vector<Link> out;
  for (size_t k = 0; k + 1 < recs.size(); ++k) {
    const double dt = tr.t[k + 1] - tr.t[k];
    if (dt < 1.0 || dt > 3 * kDay) continue;
    sdnap::Sat a = recs[k], b = recs[k + 1];
    double r1[3], v1[3], r2[3], v2[3], dr[3], dv[3];
    if (!sgp4_eval(a, dt / 60.0, r1, v1) || !sgp4_eval(b, 0.0, r2, v2)) continue;
    for (int j = 0; j < 3; ++j) dr[j] = r1[j] - r2[j], dv[j] = v1[j] - v2[j];
    Link l{dt, {}, recs[k + 1].bstar};
    rtn(r1, v1, dr, l.d), rtn(r1, v1, dv, l.d + 3);
    out.push_back(l);
  }
  return out;
}
std::array<double, 4> consecutive(const std::vector<sdnap::Sat>& recs, const Track& tr) {
  std::vector<double> r, t, n;
  double tmax = kNaN;
  for (const Link& l : links(recs, tr)) {
    r.push_back(std::fabs(l.d[0])), t.push_back(std::fabs(l.d[1])), n.push_back(std::fabs(l.d[2]));
    tmax = std::isfinite(tmax) ? std::max(tmax, t.back()) : t.back();
  }
  return {median(r), median(t), median(n), tmax};
}
// Jump between consecutive windows at the later one's start (km, RTN).
std::array<double, 4> jumps(const History& h, double w0, double w1) {
  std::vector<double> r, t, n;
  for (size_t k = 0; k + 1 < h.windows.size(); ++k) {
    const Window &a = h.windows[k], &b = h.windows[k + 1];
    if (a.t < w0 || b.t >= w1 || !a.has_end || std::fabs(a.end[0] - b.samples[0][0]) > 1.0) continue;
    double d[3], o[3];
    for (int j = 0; j < 3; ++j) d[j] = a.end[1 + j] - b.samples[0][1 + j];
    rtn(&b.samples[0][1], &b.samples[0][4], d, o);
    r.push_back(std::fabs(o[0])), t.push_back(std::fabs(o[1])), n.push_back(std::fabs(o[2]));
  }
  double tmax = kNaN;
  for (double x : t) tmax = std::isfinite(tmax) ? std::max(tmax, x) : x;
  return {median(r), median(t), median(n), tmax};
}

// ── generators ──
// One consecutive pair of a donor's sets: the change in n (rev/day), e cos w,
// e sin w, i (deg), node and argument of latitude (deg) beyond SGP4's
// secular motion of the first set, the interval and the second set's B*.
struct Change {
  double dt, d[6], bstar;
};
struct Donor {   // a real history reduced to what the generators draw from
  std::string id;
  const History* history = nullptr;
  double i_med = 0;
  double t0 = 0, n0 = 0, ndot = 0, e = 0, i0 = 0, idot = 0, argp_mean = 0, argp_r = 0, along_sigma = 0, a_mean = 0;
  std::vector<double> n_res, e_res, i_res, raan_res, argp_res, bstar, intervals, steps, n_all, e_all, i_all;
  std::vector<const Set*> sets;
  std::vector<Change> changes;
  Signature sig;
  const std::vector<double>* drag = nullptr;
};
bool make_donor(const History& h, double w0, double w1, int days, Donor* d) {
  d->id = h.id, d->history = &h;
  for (const Set& s : h.sets)
    if (s.t >= w0 && s.t < w1) d->sets.push_back(&s);
  if (d->sets.size() < 6) return false;
  std::vector<double> x, n, e, i, argp;
  d->t0 = d->sets.front()->t;
  for (const Set* s : d->sets) {
    x.push_back((s->t - d->t0) / kDay), n.push_back(s->n), e.push_back(s->e), i.push_back(s->i), argp.push_back(s->argp);
    d->bstar.push_back(s->bstar);
  }
  d->n_all = n, d->e_all = e, d->i_all = i;
  for (size_t k = 1; k < x.size(); ++k)
    if (x[k] > x[k - 1]) d->intervals.push_back((x[k] - x[k - 1]) * kDay);
  // Decay and manoeuvre steps in mean motion; the noise is what remains.
  const Line ln = theil_sen(x, n);
  std::vector<double> dn;
  for (size_t k = 1; k < x.size(); ++k) dn.push_back(n[k] - n[k - 1] - ln.slope * (x[k] - x[k - 1]));
  const double floor = std::max(8.0 * robust_sigma(dn), 1e-4);
  std::vector<double> level(x.size(), 0.0);
  for (size_t k = 1; k < x.size(); ++k) {
    level[k] = level[k - 1];
    if (std::fabs(dn[k - 1]) > floor) d->steps.push_back(dn[k - 1]), level[k] += dn[k - 1];
  }
  std::vector<double> ns(x.size());
  for (size_t k = 0; k < x.size(); ++k) ns[k] = n[k] - level[k];
  const Line lns = theil_sen(x, ns);
  d->n0 = lns.intercept, d->ndot = lns.slope;
  for (size_t k = 0; k < x.size(); ++k) d->n_res.push_back(ns[k] - lns.at(x[k]));
  d->e = median(e);
  for (double v : e) d->e_res.push_back(v - d->e);
  const Line li = theil_sen(x, i);
  d->i0 = li.intercept, d->idot = li.slope;
  for (size_t k = 0; k < x.size(); ++k) d->i_res.push_back(i[k] - li.at(x[k]));
  std::vector<double> raan;
  for (const Set* s : d->sets) raan.push_back(s->raan);
  raan = unwrap_deg(raan);
  const Line lr = theil_sen(x, raan);
  for (size_t k = 0; k < x.size(); ++k) d->raan_res.push_back(raan[k] - lr.at(x[k]));
  double c = 0, s = 0;
  for (double w : argp) c += std::cos(w * kDeg), s += std::sin(w * kDeg);
  d->argp_mean = wrap_deg(std::atan2(s, c) / kDeg), d->argp_r = std::hypot(c, s) / argp.size();
  for (double w : argp) d->argp_res.push_back(std::remainder(w - d->argp_mean, 360.0));
  std::vector<sdnap::Sat> recs;
  const Track tr = gp_track(h, w0, w1, &recs);
  if (recs.size() < 6) return false;
  d->a_mean = median(tr.a), d->i_med = median(i);
  d->sig = signature(tr, w0, days);
  for (size_t k = 0; k + 1 < d->sets.size(); ++k) {
    const Set &a = *d->sets[k], &b = *d->sets[k + 1];
    const double dt = b.t - a.t;
    sdnap::Sat rec;
    if (dt < 1.0 || dt > 3 * kDay || !init_set(a, &rec)) continue;
    const double days = dt / kDay, w = (a.argp + rec.omgdot * kRatePerDay * days) * kDeg;
    Change c{dt, {b.n - a.n, b.e * std::cos(b.argp * kDeg) - a.e * std::cos(w), b.e * std::sin(b.argp * kDeg) - a.e * std::sin(w),
                  b.i - a.i, std::remainder(b.raan - a.raan - rec.xnodot * kRatePerDay * days, 360.0),
                  std::remainder(b.argp + b.ma - a.argp - a.ma - (rec.omgdot + rec.xmdot) * kRatePerDay * days, 360.0)},
             b.bstar};
    d->changes.push_back(c);
  }
  // Along-track scatter per set from consecutive agreement: a difference of
  // two independent errors has sqrt(2) times the scatter of one.
  std::vector<double> along;
  for (const Link& l : links(recs, tr)) along.push_back(l.d[1]);
  d->along_sigma = along.size() >= 3 ? robust_sigma(along) / std::sqrt(2.0) : 0.0;
  return true;
}

struct GeneratorOptions {
  std::string kind;
  double w0 = 0, w1 = 0;
  int per_target = 1;
  std::string donors = "population";
  int neighbours = 50;
  uint64_t seed = 1;
};

// The donor's history with its node and mean anomaly shifted by uniform
// constants: the same orbit elsewhere on the same shell.
History rotated(const History& donor, Rng& rng) {
  History h;
  const double dr = 360.0 * rng.uniform(), dm = 360.0 * rng.uniform();
  for (Set s : donor.sets) {
    s.raan = wrap_deg(s.raan + dr), s.ma = wrap_deg(s.ma + dm);
    h.sets.push_back(s);
  }
  return h;
}

// The target's own history with its node shifted by a uniform constant and
// every epoch shifted by up to half a period, elements unchanged: the same
// satellite elsewhere on its shell, phased by time rather than by mean
// anomaly, so each element set still falls where in the orbit the real
// one's does (published epochs sit at a preferred argument of latitude).
History fleet_copy(const History& target, Rng& rng) {
  History h;
  const double dr = 360.0 * rng.uniform();
  const double period = target.sets.empty() ? 0.0 : kDay / target.sets.front().n;
  const double dt = (rng.uniform() - 0.5) * period;
  for (Set s : target.sets) {
    s.t += dt, s.raan = wrap_deg(s.raan + dr);
    h.sets.push_back(s);
  }
  return h;
}

std::vector<double> cadence(const Donor& d, double w0, double w1, Rng& rng) {
  std::vector<double> t;
  if (d.intervals.empty()) return t;
  for (double x = w0 + rng.uniform() * rng.pick(d.intervals); x < w1; x += rng.pick(d.intervals)) t.push_back(x);
  return t;
}

// Secular SGP4 motion through the epochs: node, perigee and argument of
// latitude advance by the trapezoid of each set's SGP4 rates.
bool integrate_angles(std::vector<Set>* sets, bool frozen_argp, double argp_fixed, const std::vector<double>& argp_noise,
                      const std::vector<double>& raan_noise, double along_sigma_km, double a_km, Rng& rng) {
  double raan = 360.0 * rng.uniform(), argp = frozen_argp ? argp_fixed : 360.0 * rng.uniform();
  double u = 360.0 * rng.uniform();
  double prev[3] = {0, 0, 0};
  for (size_t k = 0; k < sets->size(); ++k) {
    Set& s = (*sets)[k];
    s.raan = raan, s.argp = argp, s.ma = u - argp;
    sdnap::Sat rec;
    if (!init_set(s, &rec)) return false;
    const double rates[3] = {rec.xnodot * kRatePerDay, rec.omgdot * kRatePerDay, rec.xmdot * kRatePerDay};
    if (k) {
      const double dt = (s.t - (*sets)[k - 1].t) / kDay;
      raan += 0.5 * (rates[0] + prev[0]) * dt;
      if (!frozen_argp) argp += 0.5 * (rates[1] + prev[1]) * dt;
      u += 0.5 * (rates[1] + prev[1] + rates[2] + prev[2]) * dt;
    }
    std::copy(rates, rates + 3, prev);
    const double w = frozen_argp ? argp_fixed + (argp_noise.empty() ? 0.0 : rng.pick(argp_noise)) : argp;
    s.raan = wrap_deg(raan + (raan_noise.empty() ? 0.0 : rng.pick(raan_noise)));
    s.argp = wrap_deg(w);
    s.ma = wrap_deg(u + along_sigma_km * rng.normal() / a_km / kDeg - w);
    if (!init_set(s, &rec)) return false;
  }
  return true;
}

History independent(const std::vector<const Donor*>& pool, const GeneratorOptions& o, Rng& rng) {
  History h;
  const Donor *dn = rng.pick(pool), *de = rng.pick(pool), *di = rng.pick(pool), *dc = rng.pick(pool);
  for (double t : cadence(*dc, o.w0, o.w1, rng)) h.sets.push_back({t, median(dn->n_all), median(de->e_all), median(di->i_all), 0, 0, 0, 0});
  if (h.sets.empty() || !integrate_angles(&h.sets, false, 0, {}, {}, 0.0, dn->a_mean, rng)) h.sets.clear();
  return h;
}

History resampled(const Donor& d, const std::vector<std::array<double, 3>>& offsets, const GeneratorOptions& o, Rng& rng) {
  History h;
  const std::array<double, 3> off = offsets.empty() ? std::array<double, 3>{0, 0, 0} : rng.pick(offsets);
  const double n_scale = 1.0 - 1.5 * off[0] / d.a_mean;   // mean motion for a + da
  std::vector<double> step_times;
  for (size_t k = 0; k < d.steps.size(); ++k) step_times.push_back(o.w0 + rng.uniform() * (o.w1 - o.w0));
  // Decay accumulated since the donor's first set: its rate times the
  // integral of the daily common mode (w[k] on day k; 1 without one).
  const std::vector<double>* w = d.drag;
  auto cumulative = [&](double t) {   // integral of the mode from o.w0 to t, days
    const double x = (t - o.w0) / kDay;
    if (!w || w->empty()) return x;
    const int last = static_cast<int>(w->size()) - 1;
    if (x <= 0) return x * (*w)[0];
    double sum = 0;
    int k = 0;
    for (; k < last && k + 1 <= x; ++k) sum += (*w)[k];
    return sum + (x - k) * (*w)[std::min(k, last)];
  };
  const double base = cumulative(d.t0);
  for (double t : cadence(d, o.w0, o.w1, rng)) {
    double n = (d.n0 + d.ndot * (cumulative(t) - base)) * n_scale + (d.n_res.empty() ? 0.0 : rng.pick(d.n_res));
    for (size_t k = 0; k < d.steps.size(); ++k)
      if (t >= step_times[k]) n += d.steps[k];
    const double e = std::max(1e-7, d.e + off[2] + (d.e_res.empty() ? 0.0 : rng.pick(d.e_res)));
    const double i = d.i0 + d.idot * (t - d.t0) / kDay + off[1] + (d.i_res.empty() ? 0.0 : rng.pick(d.i_res));
    h.sets.push_back({t, n, e, i, 0, 0, 0, d.bstar.empty() ? 0.0 : rng.pick(d.bstar)});
  }
  const bool frozen = d.argp_r > 0.9 && d.e > 2e-4;
  if (h.sets.empty() ||
      !integrate_angles(&h.sets, frozen, d.argp_mean, d.argp_res, d.raan_res, d.along_sigma, d.a_mean, rng))
    h.sets.clear();
  return h;
}

// Each set is the previous one advanced by SGP4's secular rates (node,
// perigee and argument of latitude; the eccentricity vector turns with the
// perigee), plus one of the donor's real consecutive-set changes in n,
// (e cos w, e sin w), i, node and argument of latitude beyond those rates.
// Changes are taken in the donor's order from a random start (cyclic):
// real changes are mostly estimation error that cancels over a few sets, so
// independent draws would make the orbit random-walk. Element space keeps a
// change's meaning at any node and phase. Each published set adds fresh
// dither (a quarter of the donor's scatter of each change) that the chain
// does not carry forward, so no published value copies a public one.
// Aligned: the changes start at the donor's first set and keep its epochs, so
// manoeuvres and drag days fall when they did for the donor.
History chained(const Donor& d, const std::vector<std::array<double, 3>>& offsets, const GeneratorOptions& o, Rng& rng) {
  History h;
  if (d.changes.empty()) return h;
  double scale[6];
  for (int c = 0; c < 6; ++c) {
    std::vector<double> v;
    for (const Change& x : d.changes) v.push_back(x.d[c]);
    scale[c] = 0.25 * robust_sigma(v);
  }
  const std::array<double, 3> off = offsets.empty() ? std::array<double, 3>{0, 0, 0} : rng.pick(offsets);
  const Set& first = *d.sets.front();
  const bool aligned = o.kind == "aligned";
  size_t at = aligned ? 0 : rng.index(d.changes.size());
  double t = aligned ? first.t : o.w0 + rng.uniform() * d.changes[at].dt;
  double n = first.n * (1.0 - 1.5 * off[0] / d.a_mean), i = first.i + off[1];
  const double e0 = std::max(1e-6, first.e + off[2]);
  double ec = e0 * std::cos(first.argp * kDeg), es = e0 * std::sin(first.argp * kDeg);
  double node = 360.0 * rng.uniform(), u = 360.0 * rng.uniform(), bstar = first.bstar;
  for (;;) {
    Set x{t, n + scale[0] * rng.normal(), 0, i + scale[3] * rng.normal(), 0, 0, 0, bstar};
    const double xc = ec + scale[1] * rng.normal(), xs = es + scale[2] * rng.normal();
    x.e = std::max(1e-7, std::hypot(xc, xs)), x.argp = wrap_deg(std::atan2(xs, xc) / kDeg);
    x.raan = wrap_deg(node + scale[4] * rng.normal());
    x.ma = wrap_deg(u + scale[5] * rng.normal() - x.argp);
    sdnap::Sat rec;
    if (!init_set(x, &rec)) return {};
    h.sets.push_back(x);
    const Change& c = d.changes[at];
    at = (at + 1) % d.changes.size();
    if (t + c.dt >= o.w1) break;
    const double days = c.dt / kDay, turn = rec.omgdot * kRatePerDay * days * kDeg;
    const double rc = ec * std::cos(turn) - es * std::sin(turn), rs = ec * std::sin(turn) + es * std::cos(turn);
    t += c.dt, n += c.d[0], ec = rc + c.d[1], es = rs + c.d[2], i += c.d[3];
    node += rec.xnodot * kRatePerDay * days + c.d[4];
    u += (rec.omgdot + rec.xmdot) * kRatePerDay * days + c.d[5];
    bstar = c.bstar;
    if (!(n > 0) || std::hypot(ec, es) >= 0.9) return {};
  }
  return h;
}

// ── gradient-boosted trees (logistic loss, histogram splits) ──
struct Bins {
  std::vector<std::vector<double>> cuts;   // per feature, ascending; bin 0 = missing
  uint8_t of(int f, double x) const {
    if (!std::isfinite(x)) return 0;
    return static_cast<uint8_t>(1 + (std::lower_bound(cuts[f].begin(), cuts[f].end(), x) - cuts[f].begin()));
  }
  int count(int f) const { return static_cast<int>(cuts[f].size()) + 2; }
};
Bins make_bins(const std::vector<std::vector<double>>& x, const std::vector<size_t>& rows, int nf, int bins) {
  Bins b;
  b.cuts.resize(nf);
  for (int f = 0; f < nf; ++f) {
    std::vector<double> v;
    for (size_t r : rows)
      if (std::isfinite(x[r][f])) v.push_back(x[r][f]);
    std::sort(v.begin(), v.end());
    // Cuts halfway between neighbouring values at the quantiles, so a gap
    // between classes is split in its middle.
    for (int k = 1; k < bins && v.size() > 1; ++k) {
      const size_t j = std::clamp<size_t>(v.size() * k / bins, 1, v.size() - 1);
      const double c = 0.5 * (v[j - 1] + v[j]);
      if (v[j] > v[j - 1] && (b.cuts[f].empty() || c > b.cuts[f].back())) b.cuts[f].push_back(c);
    }
  }
  return b;
}
struct Node {
  int feature = -1, bin = 0, left = -1, right = -1;
  bool missing_left = true;
  double value = 0;
};
struct Booster {
  int depth = 3, rounds = 200;
  double rate = 0.1, lambda = 1.0, min_hessian = 1.0;
  Bins bins;
  std::vector<std::vector<Node>> trees;
  std::vector<double> gain;

  double score(const std::vector<uint8_t>& b) const {
    double s = 0;
    for (const auto& t : trees) {
      int k = 0;
      while (t[k].feature >= 0) {
        const uint8_t v = b[t[k].feature];
        k = (v == 0 ? t[k].missing_left : v <= t[k].bin) ? t[k].left : t[k].right;
      }
      s += t[k].value;
    }
    return s;
  }
  int grow(std::vector<Node>* tree, const std::vector<std::vector<uint8_t>>& b, std::vector<size_t> rows,
           const std::vector<double>& g, const std::vector<double>& h, int level) {
    double G = 0, H = 0;
    for (size_t r : rows) G += g[r], H += h[r];
    const int at = static_cast<int>(tree->size());
    tree->push_back(Node{});
    if (level < depth) {
      const int nf = static_cast<int>(bins.cuts.size());
      double best = 0;
      int bf = -1, bb = 0;
      bool bl = true;
      for (int f = 0; f < nf; ++f) {
        const int nb = bins.count(f);
        std::vector<double> hg(nb, 0.0), hh(nb, 0.0);
        for (size_t r : rows) hg[b[r][f]] += g[r], hh[b[r][f]] += h[r];
        double gl = 0, hl = 0;
        for (int k = 1; k + 1 < nb; ++k) {
          gl += hg[k], hl += hh[k];
          for (bool ml : {true, false}) {
            const double GL = gl + (ml ? hg[0] : 0), HL = hl + (ml ? hh[0] : 0), GR = G - GL, HR = H - HL;
            if (HL < min_hessian || HR < min_hessian) continue;
            const double gn = GL * GL / (HL + lambda) + GR * GR / (HR + lambda) - G * G / (H + lambda);
            if (gn > best) best = gn, bf = f, bb = k, bl = ml;
          }
        }
      }
      if (bf >= 0) {
        gain[bf] += best;
        std::vector<size_t> L, R;
        for (size_t r : rows) {
          const uint8_t v = b[r][bf];
          ((v == 0 ? bl : v <= bb) ? L : R).push_back(r);
        }
        (*tree)[at].feature = bf, (*tree)[at].bin = bb, (*tree)[at].missing_left = bl;
        const int l = grow(tree, b, std::move(L), g, h, level + 1);
        (*tree)[at].left = l;
        const int rr = grow(tree, b, std::move(R), g, h, level + 1);
        (*tree)[at].right = rr;
        return at;
      }
    }
    (*tree)[at].value = -rate * G / (H + lambda);
    return at;
  }
  // Labels 1 real, 0 decoy; each class weighs half.
  void fit(const std::vector<std::vector<double>>& x, const std::vector<int>& y, const std::vector<size_t>& rows, int nb) {
    const int nf = static_cast<int>(x[0].size());
    bins = make_bins(x, rows, nf, nb);
    gain.assign(nf, 0.0);
    trees.clear();
    std::vector<std::vector<uint8_t>> b(x.size());
    for (size_t r : rows) {
      b[r].resize(nf);
      for (int f = 0; f < nf; ++f) b[r][f] = bins.of(f, x[r][f]);
    }
    double pos = 0;
    for (size_t r : rows) pos += y[r];
    const double neg = rows.size() - pos;
    std::vector<double> w(x.size(), 0.0), s(x.size(), 0.0), g(x.size(), 0.0), h(x.size(), 0.0);
    for (size_t r : rows) w[r] = rows.size() / (2.0 * (y[r] ? pos : neg));
    for (int t = 0; t < rounds; ++t) {
      for (size_t r : rows) {
        const double p = 1.0 / (1.0 + std::exp(-s[r]));
        g[r] = w[r] * (p - y[r]), h[r] = w[r] * std::max(p * (1 - p), 1e-6);
      }
      std::vector<Node> tree;
      grow(&tree, b, rows, g, h, 0);
      trees.push_back(tree);
      for (size_t r : rows) s[r] += score_tree(trees.back(), b[r]);
    }
  }
  static double score_tree(const std::vector<Node>& t, const std::vector<uint8_t>& b) {
    int k = 0;
    while (t[k].feature >= 0) {
      const uint8_t v = b[t[k].feature];
      k = (v == 0 ? t[k].missing_left : v <= t[k].bin) ? t[k].left : t[k].right;
    }
    return t[k].value;
  }
  double predict(const std::vector<double>& x) const {
    std::vector<uint8_t> b(x.size());
    for (size_t f = 0; f < x.size(); ++f) b[f] = bins.of(static_cast<int>(f), x[f]);
    return score(b);
  }
};

// P(real scores above a decoy), ties half (Mann-Whitney).
double auc(const std::vector<double>& real, const std::vector<double>& decoy) {
  std::vector<std::pair<double, int>> all;
  for (double s : real)
    if (std::isfinite(s)) all.push_back({s, 1});
  for (double s : decoy)
    if (std::isfinite(s)) all.push_back({s, 0});
  std::sort(all.begin(), all.end());
  double rank_sum = 0, nr = 0;
  for (size_t k = 0; k < all.size();) {
    size_t j = k;
    while (j < all.size() && all[j].first == all[k].first) ++j;
    const double rank = 0.5 * (k + j - 1) + 1;
    for (size_t m = k; m < j; ++m)
      if (all[m].second) rank_sum += rank, ++nr;
    k = j;
  }
  const double nd = all.size() - nr;
  return nr && nd ? (rank_sum - nr * (nr + 1) / 2) / (nr * nd) : kNaN;
}
// One-sided Clopper-Pearson bounds on a binomial proportion.
double binomial_tail(int k, int n, double p) {   // P(X >= k)
  if (k <= 0) return 1.0;
  if (p <= 0) return 0.0;
  if (p >= 1) return 1.0;
  double s = 0;
  for (int x = k; x <= n; ++x)
    s += std::exp(std::lgamma(n + 1.0) - std::lgamma(x + 1.0) - std::lgamma(n - x + 1.0) + x * std::log(p) +
                  (n - x) * std::log1p(-p));
  return std::min(1.0, s);
}
double cp_lower(int k, int n, double alpha) {
  if (k == 0) return 0.0;
  double lo = 0, hi = 1;
  for (int it = 0; it < 60; ++it) {
    const double m = 0.5 * (lo + hi);
    (binomial_tail(k, n, m) > alpha ? hi : lo) = m;
  }
  return lo;
}
double cp_upper(int k, int n, double alpha) {
  if (k == n) return 1.0;
  double lo = 0, hi = 1;
  for (int it = 0; it < 60; ++it) {
    const double m = 0.5 * (lo + hi);
    (1.0 - binomial_tail(k + 1, n, m) > alpha ? lo : hi) = m;
  }
  return hi;
}
// eps >= ln(P_p(S) / P_q(S)) for every set S; S = {score > tau} (or its
// complement, decoy side) chosen on one half of the targets, bounded at 95 %
// one-sided each on the other half.
struct Epsilon {
  bool ok = false, above = true;
  double lower = 0, tau = 0;
  int kr = 0, nr = 0, kd = 0, nd = 0;
};
Epsilon epsilon_bound(const std::vector<double>& s, const std::vector<int>& y, const std::vector<int>& half) {
  struct Best {
    double tau = kNaN, value = -INFINITY;
    bool above = true;
  } best;
  std::vector<double> taus;
  for (size_t r = 0; r < s.size(); ++r)
    if (half[r] == 0 && std::isfinite(s[r])) taus.push_back(s[r]);
  std::sort(taus.begin(), taus.end());
  std::vector<double> candidates;
  for (int q = 1; q < 400 && !taus.empty(); ++q) candidates.push_back(taus[taus.size() * q / 400]);
  auto counts = [&](int which, double tau, bool above, int* kr, int* nr, int* kd, int* nd) {
    *kr = *nr = *kd = *nd = 0;
    for (size_t r = 0; r < s.size(); ++r) {
      if (half[r] != which || !std::isfinite(s[r])) continue;
      const bool in = above ? s[r] > tau : s[r] <= tau;
      if (y[r]) ++*nr, *kr += in;
      else ++*nd, *kd += in;
    }
  };
  for (double tau : candidates)
    for (bool above : {true, false}) {
      int kr, nr, kd, nd;
      counts(0, tau, above, &kr, &nr, &kd, &nd);
      if (!nr || !nd) continue;
      // real more likely above (above) or decoy more likely below (!above)
      const double pr = (kr + 0.5) / (nr + 1.0), pd = (kd + 0.5) / (nd + 1.0);
      const double v = above ? std::log(pr / pd) : std::log(pd / pr);
      if (v > best.value) best = {tau, v, above};
    }
  Epsilon out;
  if (!std::isfinite(best.tau)) return out;
  int kr, nr, kd, nd;
  counts(1, best.tau, best.above, &kr, &nr, &kd, &nd);
  if (!nr || !nd) return out;
  const double lower = best.above ? std::log(cp_lower(kr, nr, 0.05) / cp_upper(kd, nd, 0.05))
                                  : std::log(cp_lower(kd, nd, 0.05) / cp_upper(kr, nr, 0.05));
  out.ok = true;
  out.lower = std::max(0.0, lower);
  out.tau = best.tau;
  out.above = best.above;
  out.kr = kr, out.nr = nr, out.kd = kd, out.nd = nd;
  return out;
}

}  // namespace

// ─────────────────────────────── methods ───────────────────────────────

// Settings: node config (plugin.getConfig), one table per method: decoys,
// features and distinguish, with the keys the JSON options had.

extern "C" int decoys() {
  const sdm_piv::Config config = sdm_piv::get_config();
  if (!config.ok()) return fail("config-unavailable", "plugin.getConfig failed: " + std::string(config.error_message()));
  const LFV* population = root<LFV>(input("population"), "$LFV");
  if (!population) return fail("invalid-input", "population must be an $LFV");
  const sdm_piv::ConfigTable options = config.table("decoys");
  GeneratorOptions o;
  o.kind = std::string(options.string("generator"));
  if (o.kind != "independent" && o.kind != "rotated" && o.kind != "resampled" && o.kind != "chained" && o.kind != "aligned" &&
      o.kind != "fleet")
    return fail("invalid-options", "generator must be independent, rotated, resampled, chained, aligned or fleet");
  const sdm_piv::Span<double> window = options.numbers("window");
  if (window.size() != 2) return fail("invalid-options", "window [from, to) in unix seconds is required");
  o.w0 = window[0], o.w1 = window[1];
  o.per_target = static_cast<int>(options.number("perTarget", 1));
  o.donors = std::string(options.string("donors", "population"));
  o.neighbours = static_cast<int>(options.number("neighbours", 50));
  o.seed = static_cast<uint64_t>(options.number("seed", 1));
  if (!(o.w1 > o.w0) || o.per_target < 1 || (o.donors != "population" && o.donors != "regime"))
    return fail("invalid-options", "window must be increasing, perTarget >= 1, donors population or regime");
  std::vector<History> reals;
  std::string error;
  if (!read_histories(population, nullptr, &reals, &error)) return fail("invalid-population", error);
  const int days = static_cast<int>(std::ceil((o.w1 - o.w0) / kDay));

  // Donors, the drag common mode and the catalog-neighbour offsets.
  std::vector<Donor> donors(reals.size());
  std::vector<const Donor*> pool;
  std::vector<std::vector<double>> daily_a;
  Catalog catalog;
  for (size_t k = 0; k < reals.size(); ++k) {
    if (!make_donor(reals[k], o.w0, o.w1, days, &donors[k])) continue;
    pool.push_back(&donors[k]);
    daily_a.push_back(donors[k].sig.a);
    catalog.sigs.push_back(donors[k].sig), catalog.ids.push_back(donors[k].id);
  }
  if (pool.size() < 10) return fail("too-few-objects", "fewer than 10 population histories have 6 element sets in the window");
  const CommonMode cm = common_mode(daily_a, days);
  for (auto& d : donors)
    if (!d.sets.empty()) d.drag = cm.at(d.a_mean - kRe);
  catalog.index();
  std::vector<std::array<double, 3>> offsets;
  for (size_t k = 0; k < catalog.sigs.size(); ++k) {
    size_t who = k;
    if (!std::isfinite(catalog.nearest(catalog.sigs[k], catalog.ids[k], &who)) || who == k) continue;
    const Donor &a = *pool[k], &b = *pool[who];
    offsets.push_back({b.a_mean - a.a_mean, b.i_med - a.i_med, b.e - a.e});
  }

  std::vector<std::string> targets;
  if (options.has("targets"))
    for (std::string_view t : options.strings("targets")) targets.push_back(std::string(t));
  else
    for (const Donor* d : pool) targets.push_back(d->id);
  std::unordered_map<std::string, size_t> where;
  for (size_t k = 0; k < pool.size(); ++k) where[pool[k]->id] = k;

  std::vector<History> out;
  int refused = 0;
  for (const std::string& target : targets) {
    const auto it = where.find(target);
    if (it == where.end()) continue;
    // Donor candidates: everyone but the target, or its nearest neighbours in (a, i).
    std::vector<const Donor*> candidates;
    for (const Donor* d : pool)
      if (d->id != target) candidates.push_back(d);
    if (o.donors == "regime") {
      const Donor& t = *pool[it->second];
      std::sort(candidates.begin(), candidates.end(), [&](const Donor* p, const Donor* q) {
        auto dist = [&](const Donor* d) {
          const double da = (d->a_mean - t.a_mean) / 25.0, di = (d->i_med - t.i_med) / 1.0;
          return da * da + di * di;
        };
        return dist(p) < dist(q);
      });
      candidates.resize(std::min<size_t>(candidates.size(), o.neighbours));
    }
    for (int k = 0; k < o.per_target; ++k) {
      Rng rng(mix(o.seed ^ mix(hash_text(o.kind)) ^ mix(hash_text(target)) ^ mix(static_cast<uint64_t>(k) + 1)));
      History h;
      if (o.kind == "independent") h = independent(candidates, o, rng);
      else if (o.kind == "rotated") h = rotated(*rng.pick(candidates)->history, rng);
      else if (o.kind == "fleet") h = fleet_copy(*pool[it->second]->history, rng);
      else if (o.kind == "resampled") h = resampled(*rng.pick(candidates), offsets, o, rng);
      else h = chained(*rng.pick(candidates), offsets, o, rng);
      if (h.sets.size() < 6) {
        ++refused;
        continue;
      }
      h.id = o.kind + ":" + target + ":" + std::to_string(k);
      h.target = target, h.role = "decoy", h.generator = o.kind;
      out.push_back(std::move(h));
    }
  }
  // The decoys as $LFV rows; SOURCE_COUNT the targets asked, REFERENCE_COUNT
  // the population with 6 element sets in the window (the donors), and
  // SKIPPED_COUNT the decoys refused for fewer than 6 sets.
  flatbuffers::FlatBufferBuilder fbb(1 << 16);
  const auto rows = write_histories(fbb, out);
  LFVBuilder b(fbb);
  b.add_WINDOW_START_MS(static_cast<int64_t>(std::llround(o.w0 * 1000.0)));
  b.add_WINDOW_END_MS(static_cast<int64_t>(std::llround(o.w1 * 1000.0)));
  b.add_MIN_POINTS(6);
  b.add_ROWS(rows);
  b.add_SOURCE_COUNT(static_cast<uint32_t>(targets.size()));
  b.add_REFERENCE_COUNT(static_cast<uint32_t>(pool.size()));
  b.add_SKIPPED_COUNT(static_cast<uint32_t>(refused));
  return emit_lfv("decoys", fbb, b.Finish());
}

extern "C" int features() {
  const sdm_piv::Config config = sdm_piv::get_config();
  if (!config.ok()) return fail("config-unavailable", "plugin.getConfig failed: " + std::string(config.error_message()));
  const LFV* histories = root<LFV>(input("histories"), "$LFV");
  const plugin_input_frame_t* eph = input("ephemerides");
  const OEM* oem = eph && eph->payload ? root<OEM>(eph, "$OEM") : nullptr;
  if (!histories || (eph && eph->payload && !oem)) return fail("invalid-input", "histories must be an $LFV and ephemerides an $OEM");
  const sdm_piv::ConfigTable options = config.table("features");
  const std::string view = std::string(options.string("view"));
  if (view != "gp" && view != "ffm") return fail("invalid-options", "view must be gp or ffm");
  const sdm_piv::Span<double> window = options.numbers("window");
  if (window.size() != 2) return fail("invalid-options", "window [from, to) in unix seconds is required");
  const double w0 = window[0], w1 = window[1];
  const int days = static_cast<int>(std::ceil((w1 - w0) / kDay));
  const size_t min_points = static_cast<size_t>(options.number("minPoints", view == "gp" ? 6 : 8));
  std::vector<History> list;
  std::string error;
  if (!read_histories(histories, oem, &list, &error)) return fail("invalid-histories", error);

  std::vector<Track> tracks(list.size());
  std::vector<std::vector<sdnap::Sat>> recs(list.size());
  std::vector<Signature> sigs(list.size());
  std::vector<std::vector<double>> seqs(list.size());
  std::vector<std::vector<double>> real_daily;
  Catalog catalog;
  for (size_t k = 0; k < list.size(); ++k) {
    tracks[k] = view == "gp" ? gp_track(list[k], w0, w1, &recs[k]) : ffm_track(list[k], w0, w1);
    sigs[k] = signature(tracks[k], w0, days);
    // Sequence of changes: mean motion between element sets (gp), or
    // orbit-averaged a between windows (ffm).
    if (view == "gp") {
      std::vector<double> n;
      for (const Set& x : list[k].sets)
        if (x.t >= w0 && x.t < w1) n.push_back(x.n);
      seqs[k] = differences(n);
    } else {
      seqs[k] = differences(tracks[k].a);
    }
    if (list[k].role == "real" && tracks[k].t.size() >= min_points) {
      real_daily.push_back(sigs[k].a);
      catalog.sigs.push_back(sigs[k]), catalog.seqs.push_back(seqs[k]), catalog.ids.push_back(list[k].id);
    }
  }
  catalog.index();
  const CommonMode cm = common_mode(real_daily, days);

  std::vector<std::string> names = core_names();
  if (view == "gp")
    for (const char* n : {"setsPerDay", "intervalMedianH", "intervalCv", "bstar", "bstarScatter", "consecutiveRKm",
                          "consecutiveTKm", "consecutiveNKm", "consecutiveTMaxKm"})
      names.push_back(n);
  else
    for (const char* n : {"jumpRKm", "jumpTKm", "jumpNKm", "jumpTMaxKm"}) names.push_back(n);
  names.push_back("dragCommonModeCorrelation");
  names.push_back("sequenceMatch");
  names.push_back("catalogDistance");

  flatbuffers::FlatBufferBuilder fbb(1 << 16);
  std::vector<flatbuffers::Offset<LFVRow>> rows;
  int skipped = 0;
  for (size_t k = 0; k < list.size(); ++k) {
    const Track& tr = tracks[k];
    if (tr.t.size() < min_points) {
      ++skipped;
      continue;
    }
    std::vector<double> x;
    push_core(core_features(tr, (w1 - w0) / kDay), &x);
    if (view == "gp") {
      std::vector<double> dt, bstar;
      for (size_t j = 1; j < tr.t.size(); ++j) dt.push_back((tr.t[j] - tr.t[j - 1]) / 3600.0);
      for (const Set& s : list[k].sets)
        if (s.t >= w0 && s.t < w1) bstar.push_back(s.bstar);
      double mean = 0, var = 0;
      for (double v : dt) mean += v;
      mean /= std::max<size_t>(dt.size(), 1);
      for (double v : dt) var += (v - mean) * (v - mean);
      x.push_back(tr.t.size() / ((w1 - w0) / kDay));
      x.push_back(median(dt));
      x.push_back(dt.size() > 1 ? std::sqrt(var / (dt.size() - 1)) / mean : kNaN);
      x.push_back(median(bstar));
      x.push_back(robust_sigma(bstar));
      for (double v : consecutive(recs[k], tr)) x.push_back(v);
    } else {
      for (double v : jumps(list[k], w0, w1)) x.push_back(v);
    }
    const std::vector<double>* drag = cm.at(sigs[k].a_mean - kRe);
    x.push_back(drag ? correlation(differences(sigs[k].a), *drag, 8) : kNaN);
    x.push_back(catalog.sequence_match(sigs[k], seqs[k], list[k].target));
    x.push_back(catalog.nearest(sigs[k], list[k].target));
    for (double& v : x) v = finite_or_nan(v);
    const History& h = list[k];
    rows.push_back(CreateLFVRowDirect(fbb, h.id.c_str(), h.target.c_str(), role_of(h.role), h.generator.empty() ? nullptr : h.generator.c_str(),
                                      h.cls.empty() ? nullptr : h.cls.c_str(), &x));
  }
  std::vector<flatbuffers::Offset<flatbuffers::String>> name_offsets;
  for (const std::string& n : names) name_offsets.push_back(fbb.CreateString(n));
  const auto lfv = CreateLFVDirect(fbb, view.c_str(), &name_offsets, nullptr, static_cast<int64_t>(std::llround(w0 * 1000.0)),
                                   static_cast<int64_t>(std::llround(w1 * 1000.0)), static_cast<uint32_t>(min_points), &rows,
                                   static_cast<uint32_t>(list.size()), static_cast<uint32_t>(catalog.sigs.size()), static_cast<uint32_t>(skipped));
  return emit_lfv("features", fbb, lfv);
}

// P(the real candidate is picked first of n) when a decoy scores below it with
// probability a and ties it with probability t, ties broken uniformly.
double p_first(double a, double t, int n) {
  if (t < 1e-15) return std::pow(a, n - 1);
  return (std::pow(a + t, n) - std::pow(a, n)) / (n * t);
}

extern "C" int distinguish() {
  const sdm_piv::Config config = sdm_piv::get_config();
  if (!config.ok()) return fail("config-unavailable", "plugin.getConfig failed: " + std::string(config.error_message()));
  const LFV* input_rows = root<LFV>(input("features"), "$LFV");
  if (!input_rows || !input_rows->ROWS() || !input_rows->FEATURE_NAMES())
    return fail("invalid-features", "features must be an $LFV with FEATURE_NAMES and ROWS (TARGET, ROLE, VALUES)");
  const sdm_piv::ConfigTable opt = config.table("distinguish");
  const int folds = static_cast<int>(opt.number("folds", 5));
  Booster proto;
  proto.depth = static_cast<int>(opt.number("depth", 3)), proto.rounds = static_cast<int>(opt.number("rounds", 200));
  proto.rate = opt.number("learningRate", 0.1), proto.lambda = opt.number("lambda", 1.0);
  proto.min_hessian = opt.number("minChildHessian", 1.0);
  const int nbins = std::clamp(static_cast<int>(opt.number("bins", 32)), 2, 250);
  const uint64_t seed = static_cast<uint64_t>(opt.number("seed", 1));
  std::vector<int> ranks = {2, 10, 100, 1000, 10000};
  if (opt.has("ranks")) {
    ranks.clear();
    for (double n : opt.numbers("ranks")) ranks.push_back(static_cast<int>(n));
  }

  std::vector<std::string> all_names;
  for (const flatbuffers::String* n : *input_rows->FEATURE_NAMES()) all_names.push_back(text(n));
  std::vector<std::string> exclude;
  for (std::string_view e : opt.strings("exclude")) exclude.push_back(std::string(e));
  std::vector<size_t> keep;
  std::vector<std::string> names;
  for (size_t f = 0; f < all_names.size(); ++f)
    if (std::find(exclude.begin(), exclude.end(), all_names[f]) == exclude.end()) keep.push_back(f), names.push_back(all_names[f]);
  std::vector<std::vector<double>> x;
  std::vector<int> y, fold, half;
  std::vector<std::string> cls, target;
  for (const LFVRow* r : *input_rows->ROWS()) {
    const auto* values = r->VALUES();
    if ((values ? values->size() : 0) != all_names.size()) return fail("invalid-features", "every row needs one value per name");
    std::vector<double> v;
    for (size_t f : keep) v.push_back(values->Get(static_cast<flatbuffers::uoffset_t>(f)));
    std::string t = text(r->TARGET());
    if (t.empty()) t = text(r->SOURCE_ID());
    const uint64_t g = mix(hash_text(t) ^ seed);
    x.push_back(v), y.push_back(r->ROLE() == lfvRole::Real);
    fold.push_back(static_cast<int>(g % folds)), half.push_back(static_cast<int>((g >> 32) % 2));
    cls.push_back(text(r->CLASS_LABEL()));
    target.push_back(std::move(t));
  }
  int nr = 0;
  for (int v : y) nr += v;
  const int nd = static_cast<int>(y.size()) - nr;
  if (nr < 20 || nd < 20) return fail("too-few-rows", "need at least 20 real and 20 decoy rows");
  std::map<std::string, std::vector<size_t>> groups;
  for (size_t r = 0; r < x.size(); ++r) groups[target[r]].push_back(r);
  // Relative: each feature minus its median over the target's own candidates,
  // so the classifier compares a set's members with each other (an adversary
  // facing copies of one orbit).
  const bool relative = opt.boolean("relative", false);
  if (relative)
    for (const auto& [t, rows] : groups)
      for (size_t f = 0; f < names.size(); ++f) {
        std::vector<double> v;
        for (size_t r : rows) v.push_back(x[r][f]);
        const double m = median(v);
        for (size_t r : rows)
          if (std::isfinite(m)) x[r][f] -= m;
      }

  // Out-of-fold scores.
  std::vector<double> score(x.size(), kNaN), gain(names.size(), 0.0);
  for (int f = 0; f < folds; ++f) {
    std::vector<size_t> train;
    for (size_t r = 0; r < x.size(); ++r)
      if (fold[r] != f) train.push_back(r);
    Booster b = proto;
    b.fit(x, y, train, nbins);
    for (size_t k = 0; k < gain.size(); ++k) gain[k] += b.gain[k];
    for (size_t r = 0; r < x.size(); ++r)
      if (fold[r] == f) score[r] = b.predict(x[r]);
  }
  std::vector<double> sr, sd;
  for (size_t r = 0; r < x.size(); ++r) (y[r] ? sr : sd).push_back(score[r]);
  std::sort(sd.begin(), sd.end());
  // The adversary picks the highest of N scores; decoys are independent
  // draws, so P(real first) = E[F(s_real)^(N-1)], F the decoy score CDF.
  auto top = [&](const std::vector<double>& reals, int n) {
    double p = 0;
    for (double s : reals) {
      const double below = std::lower_bound(sd.begin(), sd.end(), s) - sd.begin();
      const double ties = (std::upper_bound(sd.begin(), sd.end(), s) - sd.begin()) - below;
      p += p_first(below / sd.size(), ties / sd.size(), n);
    }
    return p / reals.size();
  };
  flatbuffers::FlatBufferBuilder fbb(1 << 14);
  using RankOffsets = std::vector<flatbuffers::Offset<LFVRankProbability>>;
  auto rank = [&](int n, double p, double ideal) {
    return CreateLFVRankProbability(fbb, static_cast<uint32_t>(n), p, p > 0 ? 1.0 / p : kNaN, ideal);
  };
  RankOffsets first;
  for (int n : ranks) {
    const double p = top(sr, n);
    first.push_back(rank(n, p, 1.0 / n));
  }
  std::vector<flatbuffers::Offset<LFVClassResult>> by_class;
  std::map<std::string, std::vector<double>> class_scores;
  for (size_t r = 0; r < x.size(); ++r)
    if (y[r] && !cls[r].empty()) class_scores[cls[r]].push_back(score[r]);
  for (const auto& [c, s] : class_scores) {
    RankOffsets rows;
    for (int n : ranks) {
      const double p = top(s, n);
      rows.push_back(rank(n, p, kNaN));
    }
    by_class.push_back(CreateLFVClassResultDirect(fbb, c.c_str(), static_cast<uint32_t>(s.size()), auc(s, sd), &rows));
  }
  // Which features separate on their own, and which the trees used.
  double total = 0;
  for (double g : gain) total += g;
  struct Separation {   // by value: equal gain shares keep the order the JSON build gave them
    std::string name;
    double auc, separation, gain_share;
  };
  std::vector<Separation> per;
  for (size_t f = 0; f < names.size(); ++f) {
    std::vector<double> a, b;
    for (size_t r = 0; r < x.size(); ++r) (y[r] ? a : b).push_back(x[r][f]);
    const double u = auc(a, b);
    per.push_back({names[f], finite_or_nan(u), std::isfinite(u) ? std::max(u, 1 - u) : kNaN, total > 0 ? gain[f] / total : 0.0});
  }
  std::sort(per.begin(), per.end(), [](const Separation& p, const Separation& q) { return p.gain_share > q.gain_share; });
  std::vector<flatbuffers::Offset<LFVFeatureSeparation>> separation;
  for (const Separation& p : per)
    separation.push_back(CreateLFVFeatureSeparationDirect(fbb, p.name.c_str(), p.auc, p.separation, p.gain_share));
  int correct = 0;
  for (size_t r = 0; r < x.size(); ++r) correct += (score[r] > 0) == (y[r] == 1);
  double bal_r = 0, bal_d = 0;
  for (size_t r = 0; r < x.size(); ++r) (y[r] ? bal_r : bal_d) += (score[r] > 0) == (y[r] == 1);
  // Within each target's own candidate set, when every target has many
  // decoys: the real one's rank among its own decoys (uniform when they are
  // exchangeable), P(first of N) from those ranks, and, for N beyond the set,
  // from each score standardized by its own set's decoys (median, robust
  // scale) against all sets' standardized decoys pooled.
  flatbuffers::Offset<LFVWithinGroup> within = 0;
  size_t fewest = SIZE_MAX;
  for (const auto& [t, rows] : groups) {
    size_t d = 0;
    for (size_t r : rows) d += !y[r];
    fewest = std::min(fewest, d);
  }
  if (groups.size() >= 20 && fewest >= 10) {
    std::vector<double> pooled;
    std::vector<std::array<double, 3>> reals;   // empirical a, t within the set; standardized score
    for (const auto& [t, rows] : groups) {
      std::vector<double> ds;
      double real = kNaN;
      for (size_t r : rows) {
        if (y[r]) real = score[r];
        else ds.push_back(score[r]);
      }
      if (!std::isfinite(real) || ds.empty()) continue;
      const double m = median(ds);
      double sc = robust_sigma(ds);
      if (!(sc > 0)) {
        double mean = 0, var = 0;
        for (double v : ds) mean += v;
        mean /= ds.size();
        for (double v : ds) var += (v - mean) * (v - mean);
        sc = std::sqrt(var / ds.size());
      }
      auto z = [&](double v) { return sc > 0 ? (v - m) / sc : (v > m ? 1.0 : v < m ? -1.0 : 0.0); };
      double below = 0, ties = 0;
      for (double v : ds) below += v < real, ties += v == real, pooled.push_back(z(v));
      reals.push_back({below / ds.size(), ties / ds.size(), z(real)});
    }
    std::sort(pooled.begin(), pooled.end());
    std::vector<uint32_t> histogram(10, 0);
    std::vector<double> ranks_u;
    for (const auto& r : reals) {
      const double u = r[0] + 0.5 * r[1];
      ranks_u.push_back(u);
      ++histogram[std::min(9, static_cast<int>(u * 10))];
    }
    std::sort(ranks_u.begin(), ranks_u.end());
    double ks = 0;
    for (size_t k = 0; k < ranks_u.size(); ++k)
      ks = std::max({ks, std::fabs((k + 1.0) / ranks_u.size() - ranks_u[k]), std::fabs(static_cast<double>(k) / ranks_u.size() - ranks_u[k])});
    RankOffsets empirical, standardized;
    for (int n : ranks) {
      double pe = 0, ps = 0;
      for (const auto& r : reals) {
        pe += p_first(r[0], r[1], n);
        const double below = std::lower_bound(pooled.begin(), pooled.end(), r[2]) - pooled.begin();
        const double ties = (std::upper_bound(pooled.begin(), pooled.end(), r[2]) - pooled.begin()) - below;
        ps += p_first(below / pooled.size(), ties / pooled.size(), n);
      }
      pe /= reals.size(), ps /= reals.size();
      if (static_cast<size_t>(n) <= fewest + 1) empirical.push_back(rank(n, pe, 1.0 / n));
      standardized.push_back(rank(n, ps, 1.0 / n));
    }
    within = CreateLFVWithinGroupDirect(fbb, static_cast<uint32_t>(reals.size()), static_cast<uint32_t>(fewest),
                                        static_cast<uint32_t>(pooled.size()), &histogram, ks, &empirical, &standardized);
  }
  // The held-out threshold test: the region chosen on one half of the targets,
  // counted and bounded (95 % one-sided Clopper-Pearson) on the other.
  std::vector<flatbuffers::Offset<LFVThresholdTest>> thresholds;
  const Epsilon eps = epsilon_bound(score, y, half);
  if (eps.ok)
    thresholds.push_back(CreateLFVThresholdTest(fbb, eps.tau, eps.above ? lfvRegionSide::Above : lfvRegionSide::AtOrBelow,
                                                eps.above ? lfvRole::Real : lfvRole::Decoy, static_cast<uint32_t>(eps.kr),
                                                static_cast<uint32_t>(eps.nr), static_cast<uint32_t>(eps.kd),
                                                static_cast<uint32_t>(eps.nd), eps.lower, 0.95));
  std::vector<flatbuffers::Offset<flatbuffers::String>> excluded, all;
  for (const std::string& e : exclude) excluded.push_back(fbb.CreateString(e));
  for (const std::string& n : all_names) all.push_back(fbb.CreateString(n));
  const auto classifier = CreateLFVClassifierDirect(fbb, "gradient-boosted trees, logistic loss", static_cast<uint32_t>(proto.depth),
                                                    static_cast<uint32_t>(proto.rounds), proto.rate, proto.lambda, proto.min_hessian,
                                                    static_cast<uint32_t>(nbins), static_cast<uint32_t>(folds), "by target", seed);
  const auto report = CreateLFVTestReportDirect(fbb, "cross-validated classifier", nullptr, kNaN, kNaN, static_cast<uint32_t>(nr),
                                                static_cast<uint32_t>(nd), &excluded, relative, classifier, auc(sr, sd),
                                                0.5 * (bal_r / nr + bal_d / nd), &thresholds, &first, &by_class, &separation, within);
  const std::string view = text(input_rows->VIEW());
  return emit_lfv("report", fbb, CreateLFVDirect(fbb, view.empty() ? nullptr : view.c_str(), &all, nullptr, 0, 0, 0, nullptr,
                                                 0, 0, 0, 0, report));
}
