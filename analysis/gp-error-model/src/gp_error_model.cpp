#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <map>
#include <set>
#include <string>
#include <vector>

// Empirical SGP4 prediction error, by orbit regime and prediction age.
//
// accumulate: each $OMM element set is propagated by SGP4 (Vallado 2020,
// WGS-72, opsmode i, the propagator/sgp4 sources) to comparison epochs, and
// the difference "prediction minus comparison state" is taken in the
// comparison state's RTN axes (R radial, N orbit normal, T = N x R):
//   gp-differences  the comparison state is a later element set of the same
//                   object at its own epoch; per set and age bin, the first
//                   later set in that bin. A later set is itself an estimate:
//                   these differences are not truth.
//   reference       the comparison state is an independent reference state
//                   (analysis/reference-states, GCRF/UTC); SGP4's TEME output
//                   goes to GCRF through the foundation/frames axis engine
//                   (IAU 2006/2000A and the equation of the equinoxes).
// Prediction age is comparison epoch minus element-set epoch (UTC seconds,
// SGP4's convention), forward only. The regime is the propagated set's:
// eccentricity and mean altitude (un-Kozai'd mean motion, WGS-72).
// Each stratum accumulates count, sums and second moments of the six RTN
// components, signed log histograms (20 bins a decade, 1e-9 to 1e5 km or
// km/s) and, when the caller supplies per-stratum centre and scale, the same
// moments over the samples whose position components lie within k scales.
// A prior accumulator is added to, so a catalog is processed in batches.
// finalize: mean, covariance, median, quantiles and robust sigma
// ((q84.13 - q15.87) / 2) per stratum, and the clipped mean and covariance.
//
// Coverage (reference mode with a model): each sample's position error is
// tested against its stratum's model position covariance (the clipped one
// when present), zero mean as conjunction assessment uses it: d^2 = e' C^-1 e
// against chi-square with 3 degrees of freedom. Every sample counts, outliers
// included. finalize reports the fraction inside the 1, 2 and 3 sigma
// ellipsoids (chi-square quantiles at 0.6827, 0.9545, 0.9973), mean d^2, the
// histogram of F(d^2) (uniform when calibrated) and its largest CDF gap, and
// the gate: CALIBRATED when the 1 and 2 sigma containments are within the
// tolerance of nominal and no more than the tail limit falls outside 3 sigma,
// with enough samples and distinct objects; FAILED when not; INSUFFICIENT
// without enough evidence.
// scale_model: per stratum, the model's position covariance scaled by
// s_k = sqrt(E[e_k^2] / C_kk) from reference-state errors (second moment
// about zero, clipped), so a scaled model is fitted on one reference window
// and tested on another.

namespace {

namespace fr = ::sdn::frames;
constexpr double kPi = 3.14159265358979323846;
constexpr double kDeg = kPi / 180.0;
constexpr double kMuWgs72 = 398600.8;    // km^3/s^2, SGP4's constant
constexpr double kReWgs72 = 6378.135;    // km
constexpr double kSgp4EpochFromUnixDays = 7306.0;  // days from 1949-12-31 00:00 to 1970-01-01
constexpr int kBinsPerDecade = 20;
constexpr int kDecades = 14;  // 1e-9 .. 1e5
constexpr int kMaxBin = kBinsPerDecade * kDecades;
constexpr int kComponents = 6;
const double kQuantiles[] = {0.00135, 0.02275, 0.158655, 0.5, 0.841345, 0.97725, 0.99865};

std::string error_text;
int fail(const char* code, const std::string& message) {
  plugin_set_error(code, message.c_str());
  return 1;
}

// ── time: UTC as unix day + seconds of day (SGP4 differences ignore leap seconds) ──
struct Instant {
  int64_t day = 0;
  double sec = 0.0;
};
int64_t days_from_civil(int64_t y, unsigned m, unsigned d) {
  y -= m <= 2;
  const int64_t era = (y >= 0 ? y : y - 399) / 400;
  const unsigned yoe = static_cast<unsigned>(y - era * 400);
  const unsigned doy = (153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1;
  const unsigned doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
  return era * 146097 + static_cast<int64_t>(doe) - 719468;
}
bool parse_instant(const flatbuffers::String* s, Instant* out, int* ymdhms = nullptr, double* second = nullptr) {
  if (!s || s->size() < 19) return false;
  const char* t = s->c_str();
  int y, mo, d, h, mi;
  double sec;
  if (std::sscanf(t, "%4d-%2d-%2d%*c%2d:%2d:%lf", &y, &mo, &d, &h, &mi, &sec) != 6) return false;
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || !(sec >= 0 && sec < 61)) return false;
  out->day = days_from_civil(y, mo, d);
  out->sec = h * 3600.0 + mi * 60.0 + sec;
  if (ymdhms) {
    ymdhms[0] = y; ymdhms[1] = mo; ymdhms[2] = d; ymdhms[3] = h; ymdhms[4] = mi;
    *second = sec;
  }
  return true;
}
double seconds_between(const Instant& a, const Instant& b) {  // b - a
  return static_cast<double>(b.day - a.day) * 86400.0 + (b.sec - a.sec);
}
bool before(const Instant& a, const Instant& b) { return a.day != b.day ? a.day < b.day : a.sec < b.sec; }

// ── strata ──
struct Regime {
  std::string id;
  double alt_lo, alt_hi, ecc_lo, ecc_hi;
};
struct Options {
  std::vector<Regime> regimes;
  std::vector<std::pair<double, double>> ages;  // days
  double max_age_days = 0;
  double reference_step_s = 300;
  double clip_k = 0;
  std::map<std::pair<int, int>, std::array<double, 6>> clip;  // (regime, age) -> centre[3], scale[3]
};
constexpr int kPitBins = 20;
const double kContainment[3] = {0.682689492137086, 0.954499736103642, 0.997300203936740};

double chi2_cdf3(double x) {
  if (!(x > 0)) return 0.0;
  return std::erf(std::sqrt(x / 2.0)) - std::sqrt(2.0 * x / kPi) * std::exp(-x / 2.0);
}
double chi2_quantile3(double p) {
  double lo = 0, hi = 100;
  for (int i = 0; i < 200; ++i) {
    const double mid = 0.5 * (lo + hi);
    (chi2_cdf3(mid) < p ? lo : hi) = mid;
  }
  return 0.5 * (lo + hi);
}

struct Coverage {
  uint64_t n = 0, missing = 0;
  double sum_d2 = 0;
  uint64_t inside[3] = {};
  uint64_t pit[kPitBins] = {};
  std::set<uint32_t> objects;
};

struct Stratum {
  uint64_t n = 0;
  double sum[kComponents] = {};
  double sq[21] = {};
  std::map<int, uint64_t> hist[kComponents];
  uint64_t n_clip = 0;
  double sum_clip[kComponents] = {};
  double sq_clip[21] = {};
};

void default_options(Options* o) {
  o->regimes = {
      {"LEO below 450 km", 0, 450, 0, 0.1},      {"LEO 450-600 km", 450, 600, 0, 0.1},
      {"LEO 600-800 km", 600, 800, 0, 0.1},      {"LEO 800-1200 km", 800, 1200, 0, 0.1},
      {"LEO 1200-2000 km", 1200, 2000, 0, 0.1},  {"MEO 2000-10000 km", 2000, 10000, 0, 0.1},
      {"MEO 10000-30000 km", 10000, 30000, 0, 0.1}, {"GEO 30000-40000 km", 30000, 40000, 0, 0.1},
      {"Beyond 40000 km", 40000, 1e9, 0, 0.1},    {"Eccentric (e >= 0.1)", 0, 1e9, 0.1, 1.0},
  };
  o->ages = {{0, 0.5}, {0.5, 1}, {1, 2}, {2, 3}, {3, 5}, {5, 7}};
}

std::string parse_options(const nlohmann::json& j, Options* o) {
  default_options(o);
  if (j.is_discarded() || !j.is_object()) return "options must be a JSON object.";
  if (j.contains("regimes")) {
    const auto& r = j["regimes"];
    if (!r.is_array() || r.empty()) return "regimes must be a non-empty array.";
    o->regimes.clear();
    for (const auto& x : r) {
      if (!x.is_object() || !x.contains("id") || !x["id"].is_string() || !x.contains("altitudeKm") ||
          !x["altitudeKm"].is_array() || x["altitudeKm"].size() != 2 || !x.contains("eccentricity") ||
          !x["eccentricity"].is_array() || x["eccentricity"].size() != 2)
        return "each regime needs id, altitudeKm [lo, hi] and eccentricity [lo, hi].";
      for (const auto* a : {&x["altitudeKm"], &x["eccentricity"]})
        if (!(*a)[0].is_number() || !(*a)[1].is_number()) return "regime bounds must be numbers.";
      o->regimes.push_back({x["id"].get<std::string>(), x["altitudeKm"][0].get<double>(),
                            x["altitudeKm"][1].get<double>(), x["eccentricity"][0].get<double>(),
                            x["eccentricity"][1].get<double>()});
    }
  }
  if (j.contains("ageBinsDays")) {
    const auto& a = j["ageBinsDays"];
    if (!a.is_array() || a.empty()) return "ageBinsDays must be a non-empty array.";
    o->ages.clear();
    for (const auto& x : a) {
      if (!x.is_array() || x.size() != 2 || !x[0].is_number() || !x[1].is_number() ||
          !(x[0].get<double>() >= 0) || !(x[1].get<double>() > x[0].get<double>()))
        return "each age bin is [lo, hi] days with 0 <= lo < hi.";
      o->ages.push_back({x[0].get<double>(), x[1].get<double>()});
    }
  }
  for (const auto& a : o->ages) o->max_age_days = std::max(o->max_age_days, a.second);
  if (j.contains("referenceStepSeconds")) {
    if (!j["referenceStepSeconds"].is_number() || !(j["referenceStepSeconds"].get<double>() >= 0))
      return "referenceStepSeconds must be a non-negative number.";
    o->reference_step_s = j["referenceStepSeconds"].get<double>();
  }
  if (j.contains("clip") && !j["clip"].is_null()) {
    const auto& c = j["clip"];
    if (!c.is_object() || !c.contains("k") || !c["k"].is_number() || !(c["k"].get<double>() > 0) ||
        !c.contains("strata") || !c["strata"].is_array())
      return "clip needs k > 0 and strata [{regime, age, centre[3], scale[3]}].";
    o->clip_k = c["k"].get<double>();
    for (const auto& s : c["strata"]) {
      if (!s.is_object() || !s.contains("regime") || !s["regime"].is_number_integer() || !s.contains("age") ||
          !s["age"].is_number_integer() || !s.contains("centre") || !s["centre"].is_array() ||
          s["centre"].size() != 3 || !s.contains("scale") || !s["scale"].is_array() || s["scale"].size() != 3)
        return "each clip stratum needs integer regime and age, centre[3] and scale[3] (km).";
      std::array<double, 6> v{};
      for (int k = 0; k < 3; ++k) {
        if (!s["centre"][k].is_number() || !s["scale"][k].is_number()) return "clip centre and scale must be numbers.";
        v[k] = s["centre"][k].get<double>();
        v[3 + k] = s["scale"][k].get<double>();
      }
      o->clip[{s["regime"].get<int>(), s["age"].get<int>()}] = v;
    }
  }
  return {};
}

nlohmann::json options_json(const Options& o) {
  nlohmann::json j;
  j["regimes"] = nlohmann::json::array();
  for (const auto& r : o.regimes)
    j["regimes"].push_back({{"id", r.id}, {"altitudeKm", {r.alt_lo, r.alt_hi}}, {"eccentricity", {r.ecc_lo, r.ecc_hi}}});
  j["ageBinsDays"] = nlohmann::json::array();
  for (const auto& a : o.ages) j["ageBinsDays"].push_back({a.first, a.second});
  return j;
}

// The strata definition alone, for comparing a prior, model or truth.
std::string options_signature(const nlohmann::json& j) {
  Options o;
  parse_options(j, &o);
  return options_json(o).dump();
}

int regime_of(const Options& o, double alt, double ecc) {
  for (size_t i = 0; i < o.regimes.size(); ++i) {
    const Regime& r = o.regimes[i];
    if (ecc >= r.ecc_lo && ecc < r.ecc_hi && alt >= r.alt_lo && alt < r.alt_hi) return static_cast<int>(i);
  }
  return -1;
}
int age_of(const Options& o, double days) {
  for (size_t i = 0; i < o.ages.size(); ++i)
    if (days >= o.ages[i].first && (days < o.ages[i].second || (i + 1 == o.ages.size() && days == o.ages[i].second)))
      return static_cast<int>(i);
  return -1;
}

int bin_of(double v) {
  const double a = std::fabs(v);
  if (!(a >= 1e-9)) return 0;
  int k = static_cast<int>(std::floor((std::log10(a) + 9.0) * kBinsPerDecade)) + 1;
  k = std::min(k, kMaxBin);
  return v < 0 ? -k : k;
}
// Value at fraction f in [0, 1] through signed bin s, ascending.
double bin_value(int s, double f) {
  if (s == 0) return 0.0;
  const int k = std::abs(s);
  const double lo = std::pow(10.0, (k - 1.0) / kBinsPerDecade - 9.0), hi = std::pow(10.0, double(k) / kBinsPerDecade - 9.0);
  return s > 0 ? lo + f * (hi - lo) : -hi + f * (hi - lo);
}

void add_sample(Stratum& s, const double x[kComponents], const std::array<double, 6>* clip, double k) {
  ++s.n;
  for (int a = 0, t = 0; a < kComponents; ++a) {
    s.sum[a] += x[a];
    for (int b = 0; b <= a; ++b, ++t) s.sq[t] += x[a] * x[b];
    ++s.hist[a][bin_of(x[a])];
  }
  if (!clip) return;
  for (int c = 0; c < 3; ++c)
    if (!(std::fabs(x[c] - (*clip)[c]) <= k * (*clip)[3 + c])) return;
  ++s.n_clip;
  for (int a = 0, t = 0; a < kComponents; ++a) {
    s.sum_clip[a] += x[a];
    for (int b = 0; b <= a; ++b, ++t) s.sq_clip[t] += x[a] * x[b];
  }
}

// ── element sets ──
struct ElementSet {
  uint32_t norad = 0;
  Instant epoch;
  uint32_t order = 0;  // input order, the later copy of a duplicate epoch wins
  int regime = -1;
  elsetrec rec;
  double r[3], v[3];  // TEME at epoch, km and km/s
};

struct Counts {
  uint64_t records = 0, refused = 0, duplicates = 0, unclassified = 0, samples = 0, failures = 0, objects = 0,
           reference_epochs = 0, reference_without_elements = 0;
};

bool load_elements(const Options& o, std::vector<ElementSet>& sets, Counts& counts) {
  for (uint32_t i = 0; i < plugin_get_input_count(); ++i) {
    const plugin_input_frame_t* f = plugin_get_input_frame(i);
    if (!f || !f->port_id || std::strcmp(f->port_id, "elements") != 0) continue;
    const uint8_t* p = f->payload;
    size_t at = 0, n = f->payload_length;
    while (at < n) {
      if (n - at < 8) { error_text = "truncated size-prefixed $OMM record"; return false; }
      const uint32_t len = flatbuffers::ReadScalar<uint32_t>(p + at);
      if (len > n - at - 4) { error_text = "truncated size-prefixed $OMM record"; return false; }
      // A size-prefixed buffer is aligned from its prefix: verify it whole.
      const uint8_t* rec = p + at;
      at += 4 + len;
      flatbuffers::Verifier verifier(rec, len + 4);
      if (!flatbuffers::BufferHasIdentifier(rec, OMMIdentifier(), true) || !VerifySizePrefixedOMMBuffer(verifier)) {
        error_text = "invalid size-prefixed $OMM record";
        return false;
      }
      ++counts.records;
      const OMM* omm = GetSizePrefixedOMM(rec);
      ElementSet s;
      s.norad = omm->NORAD_CAT_ID();
      s.order = static_cast<uint32_t>(counts.records);
      const double el[] = {omm->MEAN_MOTION(), omm->ECCENTRICITY(), omm->INCLINATION(), omm->RA_OF_ASC_NODE(),
                           omm->ARG_OF_PERICENTER(), omm->MEAN_ANOMALY(), omm->BSTAR()};
      bool finite = true;
      for (double x : el) finite = finite && std::isfinite(x);
      if (omm->MEAN_ELEMENT_THEORY() != meanElementSource::SGP4 || !finite || !(omm->MEAN_MOTION() > 0) || !s.norad ||
          !parse_instant(omm->EPOCH(), &s.epoch)) {
        ++counts.refused;
        continue;
      }
      std::memset(&s.rec, 0, sizeof(s.rec));
      const double epoch = static_cast<double>(s.epoch.day) + kSgp4EpochFromUnixDays + s.epoch.sec / 86400.0;
      char satn[9] = "00000";
      if (!SGP4Funcs::sgp4init(wgs72, 'i', satn, epoch, omm->BSTAR(), 0.0, 0.0, omm->ECCENTRICITY(),
                               omm->ARG_OF_PERICENTER() * kDeg, omm->INCLINATION() * kDeg, omm->MEAN_ANOMALY() * kDeg,
                               omm->MEAN_MOTION() * 2.0 * kPi / 1440.0, omm->RA_OF_ASC_NODE() * kDeg, s.rec) ||
          s.rec.error != 0 || !SGP4Funcs::sgp4(s.rec, 0.0, s.r, s.v) || s.rec.error != 0) {
        ++counts.refused;
        continue;
      }
      const double n_rad_s = s.rec.no_unkozai / 60.0;
      const double alt = std::cbrt(kMuWgs72 / (n_rad_s * n_rad_s)) - kReWgs72;
      s.regime = regime_of(o, alt, omm->ECCENTRICITY());
      if (s.regime < 0) { ++counts.unclassified; continue; }
      sets.push_back(s);
    }
  }
  std::stable_sort(sets.begin(), sets.end(), [](const ElementSet& a, const ElementSet& b) {
    if (a.norad != b.norad) return a.norad < b.norad;
    return before(a.epoch, b.epoch);
  });
  // Epochs within a second are one element set republished (the archive
  // carries copies whose epochs differ by microseconds): keep the copy that
  // came last in input order. A difference against a copy is not a prediction.
  std::vector<ElementSet> unique;
  unique.reserve(sets.size());
  for (const ElementSet& s : sets) {
    if (!unique.empty() && unique.back().norad == s.norad && seconds_between(unique.back().epoch, s.epoch) < 1.0) {
      ++counts.duplicates;
      if (s.order > unique.back().order) unique.back() = s;
      continue;
    }
    unique.push_back(s);
  }
  sets.swap(unique);
  for (size_t i = 0; i < sets.size(); ++i)
    if (i == 0 || sets[i].norad != sets[i - 1].norad) ++counts.objects;
  return true;
}

// Error of prediction (rp, vp) against comparison (rc, vc), in the comparison's RTN axes.
void rtn_error(const double rp[3], const double vp[3], const double rc[3], const double vc[3], double x[6]) {
  const double rn = std::sqrt(rc[0] * rc[0] + rc[1] * rc[1] + rc[2] * rc[2]);
  const double R[3] = {rc[0] / rn, rc[1] / rn, rc[2] / rn};
  double N[3] = {rc[1] * vc[2] - rc[2] * vc[1], rc[2] * vc[0] - rc[0] * vc[2], rc[0] * vc[1] - rc[1] * vc[0]};
  const double nn = std::sqrt(N[0] * N[0] + N[1] * N[1] + N[2] * N[2]);
  for (double& c : N) c /= nn;
  const double T[3] = {N[1] * R[2] - N[2] * R[1], N[2] * R[0] - N[0] * R[2], N[0] * R[1] - N[1] * R[0]};
  const double dr[3] = {rp[0] - rc[0], rp[1] - rc[1], rp[2] - rc[2]};
  const double dv[3] = {vp[0] - vc[0], vp[1] - vc[1], vp[2] - vc[2]};
  const double* axes[3] = {R, T, N};
  for (int k = 0; k < 3; ++k) {
    x[k] = dr[0] * axes[k][0] + dr[1] * axes[k][1] + dr[2] * axes[k][2];
    x[3 + k] = dv[0] * axes[k][0] + dv[1] * axes[k][1] + dv[2] * axes[k][2];
  }
}

struct Accumulator {
  std::string mode;
  Options options;
  Counts counts;
  std::vector<Stratum> strata;  // regime-major
  std::string coverage_model;   // empty: no coverage
  std::map<std::pair<int, int>, std::array<double, 9>> inverse;  // position covariance inverses
  std::vector<Coverage> coverage;
  double quantile[3] = {};
  size_t index(int regime, int age) const { return regime * options.ages.size() + age; }
  Stratum& at(int regime, int age) { return strata[index(regime, age)]; }
};

void sample(Accumulator& acc, int regime, int age, const double x[6], uint32_t norad) {
  const auto clip = acc.options.clip.find({regime, age});
  add_sample(acc.at(regime, age), x, clip == acc.options.clip.end() ? nullptr : &clip->second, acc.options.clip_k);
  ++acc.counts.samples;
  if (acc.coverage_model.empty()) return;
  Coverage& c = acc.coverage[acc.index(regime, age)];
  const auto inv = acc.inverse.find({regime, age});
  if (inv == acc.inverse.end()) { ++c.missing; return; }
  double d2 = 0;
  for (int a = 0; a < 3; ++a)
    for (int b = 0; b < 3; ++b) d2 += x[a] * inv->second[3 * a + b] * x[b];
  ++c.n;
  c.sum_d2 += d2;
  for (int k = 0; k < 3; ++k) c.inside[k] += d2 <= acc.quantile[k];
  ++c.pit[std::min(kPitBins - 1, static_cast<int>(chi2_cdf3(d2) * kPitBins))];
  c.objects.insert(norad);
}

// Position block of a lower-triangle 6x6 covariance, inverted; false unless
// positive definite.
bool position_inverse(const nlohmann::json& lower, std::array<double, 9>* out) {
  if (!lower.is_array() || lower.size() != 21) return false;
  double c[3][3];
  const int idx[3][3] = {{0, 1, 3}, {1, 2, 4}, {3, 4, 5}};
  for (int a = 0; a < 3; ++a)
    for (int b = 0; b < 3; ++b) {
      if (!lower[idx[a][b]].is_number()) return false;
      c[a][b] = lower[idx[a][b]].get<double>();
    }
  const double m1 = c[0][0], m2 = c[0][0] * c[1][1] - c[0][1] * c[1][0];
  const double det = c[0][0] * (c[1][1] * c[2][2] - c[1][2] * c[2][1]) - c[0][1] * (c[1][0] * c[2][2] - c[1][2] * c[2][0]) +
                     c[0][2] * (c[1][0] * c[2][1] - c[1][1] * c[2][0]);
  if (!(m1 > 0 && m2 > 0 && det > 0)) return false;
  for (int a = 0; a < 3; ++a)
    for (int b = 0; b < 3; ++b) {
      const int a1 = (a + 1) % 3, a2 = (a + 2) % 3, b1 = (b + 1) % 3, b2 = (b + 2) % 3;
      (*out)[3 * b + a] = (c[a1][b1] * c[a2][b2] - c[a1][b2] * c[a2][b1]) / det;  // cofactor transpose
    }
  return true;
}


std::string load_coverage_model(Accumulator& acc, const nlohmann::json& model) {
  if (!model.is_object() || model.value("kind", std::string()) != "gp-error-model" || !model.contains("strata"))
    return "model is not a gp-error-model.";
  if (options_signature(model) != options_signature(options_json(acc.options)))
    return "model regimes or age bins differ from these options.";
  acc.coverage_model = model.value("mode", std::string()) + (model.contains("scale") ? "+scaled" : "");
  for (const auto& s : model["strata"]) {
    if (!s.contains("regimeIndex") || !s.contains("ageIndex")) return "model stratum without regimeIndex and ageIndex.";
    const nlohmann::json& cov = s.contains("clipped") && s["clipped"].contains("covariance") ? s["clipped"]["covariance"]
                                : s.contains("covariance") ? s["covariance"] : nlohmann::json();
    std::array<double, 9> inv;
    if (position_inverse(cov, &inv)) acc.inverse[{s["regimeIndex"].get<int>(), s["ageIndex"].get<int>()}] = inv;
  }
  for (int k = 0; k < 3; ++k) acc.quantile[k] = chi2_quantile3(kContainment[k]);
  acc.coverage.assign(acc.strata.size(), Coverage());
  return {};
}

// sgp4 keeps per-call state in the record (and SDP4 its resonance
// integrator), which it restarts as needed for any time order.
bool propagate(ElementSet& s, double minutes, double r[3], double v[3]) {
  return SGP4Funcs::sgp4(s.rec, minutes, r, v) && s.rec.error == 0 && std::isfinite(r[0]) &&
         std::sqrt(r[0] * r[0] + r[1] * r[1] + r[2] * r[2]) > kReWgs72;
}

void gp_differences(Accumulator& acc, std::vector<ElementSet>& sets) {
  const double max_s = acc.options.max_age_days * 86400.0;
  for (size_t i = 0; i < sets.size(); ++i) {
    std::vector<bool> used(acc.options.ages.size(), false);
    for (size_t j = i + 1; j < sets.size() && sets[j].norad == sets[i].norad; ++j) {
      const double age_s = seconds_between(sets[i].epoch, sets[j].epoch);
      if (age_s > max_s) break;
      const int bin = age_of(acc.options, age_s / 86400.0);
      if (bin < 0 || used[bin]) continue;
      used[bin] = true;
      double r[3], v[3], x[6];
      if (!propagate(sets[i], age_s / 60.0, r, v)) { ++acc.counts.failures; continue; }
      rtn_error(r, v, sets[j].r, sets[j].v, x);
      sample(acc, sets[i].regime, bin, x, sets[i].norad);
    }
  }
}

std::string reference_errors(Accumulator& acc, std::vector<ElementSet>& sets) {
  std::map<std::string, fr::Mat3> teme;  // GCRF -> TEME per epoch
  const double max_s = acc.options.max_age_days * 86400.0;
  for (uint32_t i = 0; i < plugin_get_input_count(); ++i) {
    const plugin_input_frame_t* f = plugin_get_input_frame(i);
    if (!f || !f->port_id || std::strcmp(f->port_id, "reference") != 0) continue;
    const uint8_t* p = f->payload;
    const size_t n = f->payload_length;
    const bool prefixed = n >= 8 && flatbuffers::BufferHasIdentifier(p, OEMIdentifier(), true);
    flatbuffers::Verifier::Options vo;
    vo.max_tables = 50000000;
    flatbuffers::Verifier verifier(p, n, vo);
    if (prefixed ? !VerifySizePrefixedOEMBuffer(verifier) : !VerifyOEMBuffer(verifier))
      return "reference frames must be verifiable $OEM.";
    const OEM* oem = prefixed ? GetSizePrefixedOEM(p) : GetOEM(p);
    if (!oem->EPHEMERIS_DATA_BLOCK()) continue;
    for (const ephemerisDataBlock* b : *oem->EPHEMERIS_DATA_BLOCK()) {
      const RFM* frame = b->REFERENCE_FRAME();
      const bool gcrf = frame && ((frame->REFERENCE_FRAME_type() == RFMUnion::CelestialFrameWrapper &&
                                   frame->REFERENCE_FRAME_as_CelestialFrameWrapper()->frame() == CelestialFrame::GCRF) ||
                                  (frame->NAME() && frame->NAME()->str() == "GCRF"));
      if (!gcrf || b->TIME_SYSTEM() != timingStandard::UTC || !b->OBJECT() || !b->OBJECT()->NORAD_CAT_ID() ||
          !b->EPHEMERIS_DATA_LINES())
        return "each reference block needs GCRF, UTC, OBJECT.NORAD_CAT_ID and per-epoch lines.";
      const uint32_t norad = b->OBJECT()->NORAD_CAT_ID();
      const auto first = std::lower_bound(sets.begin(), sets.end(), norad,
                                          [](const ElementSet& s, uint32_t id) { return s.norad < id; });
      bool any = false;
      Instant kept{};
      bool have_kept = false;
      for (const ephemerisDataLine* l : *b->EPHEMERIS_DATA_LINES()) {
        Instant t;
        int ymdhm[5];
        double second;
        if (!parse_instant(l->EPOCH(), &t, ymdhm, &second)) return "reference epoch is not ISO 8601 UTC.";
        if (have_kept && seconds_between(kept, t) < acc.options.reference_step_s) continue;
        kept = t;
        have_kept = true;
        ++acc.counts.reference_epochs;
        const double rc[3] = {l->X(), l->Y(), l->Z()}, vc[3] = {l->X_DOT(), l->Y_DOT(), l->Z_DOT()};
        auto rot = teme.find(l->EPOCH()->str());
        if (rot == teme.end()) {
          fr::EarthOrientation none;  // TEME <-> GCRF needs TT only; UT1 does not enter
          fr::Epoch e;
          if (!fr::epochFromUtc(ymdhm[0], ymdhm[1], ymdhm[2], ymdhm[3], ymdhm[4], second, none, &e))
            return "reference epoch outside the leap-second table.";
          rot = teme.emplace(l->EPOCH()->str(), fr::gcrfToTeme(e)).first;
        }
        const fr::Mat3& m = rot->second;
        for (auto s = first; s != sets.end() && s->norad == norad; ++s) {
          const double age_s = seconds_between(s->epoch, t);
          if (age_s < 0) break;
          if (age_s > max_s) continue;
          const int bin = age_of(acc.options, age_s / 86400.0);
          if (bin < 0) continue;
          double r[3], v[3], rg[3], vg[3], x[6];
          if (!propagate(*s, age_s / 60.0, r, v)) { ++acc.counts.failures; continue; }
          for (int a = 0; a < 3; ++a) {  // TEME -> GCRF: transpose of GCRF -> TEME
            rg[a] = m.m[0][a] * r[0] + m.m[1][a] * r[1] + m.m[2][a] * r[2];
            vg[a] = m.m[0][a] * v[0] + m.m[1][a] * v[1] + m.m[2][a] * v[2];
          }
          rtn_error(rg, vg, rc, vc, x);
          sample(acc, s->regime, bin, x, norad);
          any = true;
        }
      }
      if (!any) ++acc.counts.reference_without_elements;
    }
  }
  return {};
}

// ── accumulator JSON ──
nlohmann::json counts_json(const Counts& c) {
  return {{"elementSets", c.records}, {"refused", c.refused}, {"duplicateEpochs", c.duplicates},
          {"unclassified", c.unclassified}, {"objects", c.objects}, {"samples", c.samples},
          {"propagationFailures", c.failures}, {"referenceEpochs", c.reference_epochs},
          {"referenceObjectsWithoutElements", c.reference_without_elements}};
}
void read_counts(const nlohmann::json& j, Counts* c) {
  auto u = [&](const char* k) { return j.contains(k) && j[k].is_number_unsigned() ? j[k].get<uint64_t>() : 0; };
  c->records += u("elementSets"); c->refused += u("refused"); c->duplicates += u("duplicateEpochs");
  c->unclassified += u("unclassified"); c->objects += u("objects"); c->samples += u("samples");
  c->failures += u("propagationFailures"); c->reference_epochs += u("referenceEpochs");
  c->reference_without_elements += u("referenceObjectsWithoutElements");
}

nlohmann::json accumulator_json(const Accumulator& acc) {
  nlohmann::json j = options_json(acc.options);
  j["kind"] = "gp-error-accumulator";
  j["version"] = 1;
  j["mode"] = acc.mode;
  j["clipK"] = acc.options.clip_k;
  j["counts"] = counts_json(acc.counts);
  if (!acc.coverage_model.empty()) j["coverageModel"] = acc.coverage_model;
  j["strata"] = nlohmann::json::array();
  for (size_t i = 0; i < acc.strata.size(); ++i) {
    const Stratum& s = acc.strata[i];
    if (!s.n) continue;
    nlohmann::json x{{"regime", i / acc.options.ages.size()}, {"age", i % acc.options.ages.size()}, {"n", s.n}};
    x["sum"] = std::vector<double>(s.sum, s.sum + kComponents);
    x["sq"] = std::vector<double>(s.sq, s.sq + 21);
    x["hist"] = nlohmann::json::array();
    for (const auto& h : s.hist) {
      nlohmann::json bins = nlohmann::json::object();
      for (const auto& b : h) bins[std::to_string(b.first)] = b.second;
      x["hist"].push_back(bins);
    }
    if (acc.options.clip_k > 0)
      x["clip"] = {{"n", s.n_clip}, {"sum", std::vector<double>(s.sum_clip, s.sum_clip + kComponents)},
                   {"sq", std::vector<double>(s.sq_clip, s.sq_clip + 21)}};
    if (!acc.coverage_model.empty()) {
      const Coverage& c = acc.coverage[i];
      x["coverage"] = {{"n", c.n}, {"missing", c.missing}, {"sumD2", c.sum_d2},
                       {"inside", std::vector<uint64_t>(c.inside, c.inside + 3)},
                       {"pit", std::vector<uint64_t>(c.pit, c.pit + kPitBins)},
                       {"objects", std::vector<uint32_t>(c.objects.begin(), c.objects.end())}};
    }
    j["strata"].push_back(x);
  }
  return j;
}

bool numbers(const nlohmann::json& j, const char* key, size_t n, double* out) {
  if (!j.contains(key) || !j[key].is_array() || j[key].size() != n) return false;
  for (size_t i = 0; i < n; ++i) {
    if (!j[key][i].is_number()) return false;
    out[i] = j[key][i].get<double>();
  }
  return true;
}

// Adds a prior accumulator into acc; the strata definitions must match.
std::string merge(Accumulator& acc, const nlohmann::json& prior) {
  if (!prior.is_object() || prior.value("kind", std::string()) != "gp-error-accumulator" || !prior.contains("strata"))
    return "prior is not a gp-error-accumulator.";
  if (options_signature(prior) != options_signature(options_json(acc.options)))
    return "prior regimes or age bins differ from these options.";
  if (prior.value("coverageModel", std::string()) != acc.coverage_model)
    return "prior was accumulated against a different coverage model.";
  if (prior.value("mode", std::string()) != acc.mode) return "prior was accumulated in a different mode.";
  if (!prior.contains("clipK") || !prior["clipK"].is_number() || prior["clipK"].get<double>() != acc.options.clip_k)
    return "prior was accumulated with a different clip.";
  if (prior.contains("counts")) read_counts(prior["counts"], &acc.counts);
  for (const auto& x : prior["strata"]) {
    if (!x.contains("regime") || !x.contains("age") || !x["regime"].is_number_unsigned() || !x["age"].is_number_unsigned())
      return "prior stratum without regime and age.";
    const size_t r = x["regime"].get<size_t>(), a = x["age"].get<size_t>();
    if (r >= acc.options.regimes.size() || a >= acc.options.ages.size()) return "prior stratum out of range.";
    Stratum& s = acc.at(static_cast<int>(r), static_cast<int>(a));
    double sum[kComponents], sq[21];
    if (!x.contains("n") || !x["n"].is_number_unsigned() || !numbers(x, "sum", kComponents, sum) || !numbers(x, "sq", 21, sq) ||
        !x.contains("hist") || !x["hist"].is_array() || x["hist"].size() != kComponents)
      return "prior stratum is malformed.";
    s.n += x["n"].get<uint64_t>();
    for (int k = 0; k < kComponents; ++k) s.sum[k] += sum[k];
    for (int k = 0; k < 21; ++k) s.sq[k] += sq[k];
    for (int c = 0; c < kComponents; ++c) {
      if (!x["hist"][c].is_object()) return "prior histogram is malformed.";
      for (const auto& b : x["hist"][c].items()) {
        if (!b.value().is_number_unsigned()) return "prior histogram is malformed.";
        s.hist[c][std::atoi(b.key().c_str())] += b.value().get<uint64_t>();
      }
    }
    if (acc.options.clip_k > 0) {
      const auto& c = x.contains("clip") ? x["clip"] : nlohmann::json();
      if (!c.is_object() || !c.contains("n") || !c["n"].is_number_unsigned() || !numbers(c, "sum", kComponents, sum) ||
          !numbers(c, "sq", 21, sq))
        return "prior clipped moments are malformed.";
      s.n_clip += c["n"].get<uint64_t>();
      for (int k = 0; k < kComponents; ++k) s.sum_clip[k] += sum[k];
      for (int k = 0; k < 21; ++k) s.sq_clip[k] += sq[k];
    }
    if (!acc.coverage_model.empty() && x.contains("coverage")) {
      const auto& c = x["coverage"];
      Coverage& cv = acc.coverage[acc.index(static_cast<int>(r), static_cast<int>(a))];
      if (!c.is_object() || !c.contains("n") || !c["n"].is_number_unsigned() || !c.contains("missing") ||
          !c["missing"].is_number_unsigned() || !c.contains("sumD2") || !c["sumD2"].is_number() || !c.contains("inside") ||
          !c["inside"].is_array() || c["inside"].size() != 3 || !c.contains("pit") || !c["pit"].is_array() ||
          c["pit"].size() != kPitBins || !c.contains("objects") || !c["objects"].is_array())
        return "prior coverage is malformed.";
      cv.n += c["n"].get<uint64_t>();
      cv.missing += c["missing"].get<uint64_t>();
      cv.sum_d2 += c["sumD2"].get<double>();
      for (int k = 0; k < 3; ++k) cv.inside[k] += c["inside"][k].get<uint64_t>();
      for (int k = 0; k < kPitBins; ++k) cv.pit[k] += c["pit"][k].get<uint64_t>();
      for (const auto& o : c["objects"]) cv.objects.insert(o.get<uint32_t>());
    }
  }
  return {};
}

const plugin_input_frame_t* input(const char* port) {
  const int32_t index = plugin_find_input_index(port, 0);
  return index >= 0 ? plugin_get_input_frame(static_cast<uint32_t>(index)) : nullptr;
}
nlohmann::json json_input(const char* port) {
  const plugin_input_frame_t* f = input(port);
  if (!f || !f->payload) return nlohmann::json(nlohmann::json::value_t::discarded);
  return nlohmann::json::parse(f->payload, f->payload + f->payload_length, nullptr, false);
}
int emit(const char* port, const nlohmann::json& j) {
  const std::string text = j.dump();
  return plugin_push_output_ex(port, nullptr, nullptr, PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY, nullptr, 0, 1,
                               reinterpret_cast<const uint8_t*>(text.data()), static_cast<uint32_t>(text.size())) < 0
             ? 1
             : 0;
}

// Mean, and the sample covariance when n > 1 (empty otherwise).
std::vector<double> moments(uint64_t n, const double* sum, const double* sq, std::vector<double>* mean) {
  mean->assign(sum, sum + kComponents);
  for (double& m : *mean) m /= static_cast<double>(n);
  if (n < 2) return {};
  std::vector<double> cov(21);
  for (int a = 0, t = 0; a < kComponents; ++a)
    for (int b = 0; b <= a; ++b, ++t)
      cov[t] = (sq[t] - n * (*mean)[a] * (*mean)[b]) / static_cast<double>(n - 1);
  return cov;
}

}  // namespace

extern "C" int accumulate() {
  Accumulator acc;
  const plugin_input_frame_t* opt = input("options");
  const nlohmann::json options = opt ? json_input("options") : nlohmann::json::object();
  std::string e = parse_options(options, &acc.options);
  if (!e.empty()) return fail("invalid-options", e);
  acc.strata.assign(acc.options.regimes.size() * acc.options.ages.size(), Stratum());
  acc.mode = plugin_find_input_index("reference", 0) >= 0 ? "reference" : "gp-differences";
  if (input("model")) {
    if (acc.mode != "reference") return fail("invalid-model", "coverage needs reference states.");
    e = load_coverage_model(acc, json_input("model"));
    if (!e.empty()) return fail("invalid-model", e);
  }
  if (input("prior")) {
    e = merge(acc, json_input("prior"));
    if (!e.empty()) return fail("invalid-prior", e);
  }
  std::vector<ElementSet> sets;
  if (!load_elements(acc.options, sets, acc.counts)) return fail("invalid-elements", error_text);
  if (acc.mode == "reference") {
    e = reference_errors(acc, sets);
    if (!e.empty()) return fail("invalid-reference", e);
  } else {
    gp_differences(acc, sets);
  }
  return emit("accumulator", accumulator_json(acc));
}

extern "C" int finalize() {
  const nlohmann::json j = json_input("accumulator");
  if (j.is_discarded() || !j.is_object() || j.value("kind", std::string()) != "gp-error-accumulator")
    return fail("invalid-accumulator", "accumulator must be gp-error-accumulator JSON.");
  Accumulator acc;
  std::string e = parse_options(j, &acc.options);
  if (!e.empty()) return fail("invalid-accumulator", e);
  acc.options.clip_k = j.contains("clipK") && j["clipK"].is_number() ? j["clipK"].get<double>() : 0;
  acc.mode = j.value("mode", std::string());
  acc.strata.assign(acc.options.regimes.size() * acc.options.ages.size(), Stratum());
  acc.coverage_model = j.value("coverageModel", std::string());
  acc.coverage.assign(acc.strata.size(), Coverage());
  e = merge(acc, j);
  if (!e.empty()) return fail("invalid-accumulator", e);
  double tolerance = 0.05, tail_limit = 0.01, min_samples = 30, min_objects = 3;
  if (input("options")) {
    const nlohmann::json o = json_input("options");
    const nlohmann::json g = o.is_object() && o.contains("gate") ? o["gate"] : nlohmann::json::object();
    if (!g.is_object()) return fail("invalid-options", "gate must be an object.");
    for (auto [key, target] : {std::pair<const char*, double*>{"tolerance", &tolerance}, {"tailLimit", &tail_limit},
                               {"minimumSamples", &min_samples}, {"minimumObjects", &min_objects}}) {
      if (!g.contains(key)) continue;
      if (!g[key].is_number() || !(g[key].get<double>() >= 0)) return fail("invalid-options", "gate values are non-negative numbers.");
      *target = g[key].get<double>();
    }
  }

  nlohmann::json out = options_json(acc.options);
  out["kind"] = "gp-error-model";
  out["version"] = 1;
  out["mode"] = acc.mode;
  out["basis"] = acc.mode == "reference"
                     ? "SGP4 predictions minus independent reference states, in the reference state's RTN axes."
                     : "SGP4 predictions minus later element sets of the same object at their epochs, in the later "
                       "set's RTN axes. A later set is an estimate, not truth.";
  out["propagator"] = "SGP4 (Vallado " SGP4Version ", WGS-72, opsmode i)";
  out["units"] = {{"position", "km"}, {"velocity", "km/s"},
                  {"components", {"R", "T", "N", "dR", "dT", "dN"}},
                  {"covariance", "lower triangle, row-major: RR, TR, TT, NR, NT, NN, dR R, ..."}};
  out["counts"] = counts_json(acc.counts);
  out["quantileProbabilities"] = std::vector<double>(std::begin(kQuantiles), std::end(kQuantiles));
  if (!acc.coverage_model.empty()) {
    out["coverageModel"] = acc.coverage_model;
    out["gate"] = {{"rule", "CALIBRATED when the fractions inside the 1 and 2 sigma ellipsoids are within the tolerance "
                            "of nominal and at most the tail limit lies outside 3 sigma, with at least the minimum "
                            "samples and distinct objects; every sample counts"},
                   {"tolerance", tolerance}, {"tailLimit", tail_limit}, {"minimumSamples", min_samples},
                   {"minimumObjects", min_objects},
                   {"nominal", std::vector<double>(std::begin(kContainment), std::end(kContainment))}};
  }
  out["strata"] = nlohmann::json::array();
  for (size_t i = 0; i < acc.strata.size(); ++i) {
    const Stratum& s = acc.strata[i];
    if (!s.n) continue;
    const size_t r = i / acc.options.ages.size(), a = i % acc.options.ages.size();
    nlohmann::json x{{"regime", acc.options.regimes[r].id}, {"regimeIndex", r}, {"ageIndex", a},
                     {"ageDays", {acc.options.ages[a].first, acc.options.ages[a].second}}, {"n", s.n}};
    std::vector<double> mean;
    const std::vector<double> cov = moments(s.n, s.sum, s.sq, &mean);
    x["mean"] = mean;
    if (!cov.empty()) x["covariance"] = cov;
    nlohmann::json q = nlohmann::json::array(), median = nlohmann::json::array(), sigma = nlohmann::json::array();
    for (int c = 0; c < kComponents; ++c) {
      std::vector<double> values;
      uint64_t cum = 0;
      auto it = s.hist[c].begin();
      for (double p : kQuantiles) {
        const double target = p * static_cast<double>(s.n);
        while (it != s.hist[c].end() && static_cast<double>(cum + it->second) < target) cum += (it++)->second;
        if (it == s.hist[c].end()) { values.push_back(bin_value(s.hist[c].rbegin()->first, 1.0)); continue; }
        values.push_back(bin_value(it->first, (target - cum) / static_cast<double>(it->second)));
      }
      q.push_back(values);
      median.push_back(values[3]);
      sigma.push_back((values[4] - values[2]) / 2.0);
    }
    x["quantiles"] = q;
    x["median"] = median;
    x["robustSigma"] = sigma;
    if (acc.options.clip_k > 0) {
      nlohmann::json c{{"k", acc.options.clip_k}, {"n", s.n_clip},
                       {"fractionRemoved", 1.0 - static_cast<double>(s.n_clip) / static_cast<double>(s.n)}};
      if (s.n_clip > 0) {
        const std::vector<double> clipped = moments(s.n_clip, s.sum_clip, s.sq_clip, &mean);
        c["mean"] = mean;
        if (!clipped.empty()) c["covariance"] = clipped;
      }
      x["clipped"] = c;
    }
    if (!acc.coverage_model.empty()) {
      const Coverage& c = acc.coverage[i];
      nlohmann::json g{{"n", c.n}, {"missingModel", c.missing}, {"objects", c.objects.size()}};
      if (c.n) {
        const double n = static_cast<double>(c.n);
        std::vector<double> inside(3), pit(kPitBins);
        bool within = true;
        for (int k = 0; k < 3; ++k) inside[k] = c.inside[k] / n;
        for (int k = 0; k < 2; ++k) within = within && std::fabs(inside[k] - kContainment[k]) <= tolerance;
        within = within && 1.0 - inside[2] <= tail_limit;
        double cum = 0, gap = 0;
        for (int k = 0; k < kPitBins; ++k) {
          pit[k] = c.pit[k] / n;
          cum += pit[k];
          gap = std::max(gap, std::fabs(cum - (k + 1.0) / kPitBins));
        }
        g["meanD2"] = c.sum_d2 / n;
        g["inside"] = inside;
        g["pit"] = pit;
        g["pitMaxCdfGap"] = gap;
        g["status"] = n < min_samples || c.objects.size() < min_objects ? "INSUFFICIENT" : within ? "CALIBRATED" : "FAILED";
      } else {
        g["status"] = c.missing ? "NO_MODEL" : "INSUFFICIENT";
      }
      x["coverage"] = g;
    }
    out["strata"].push_back(x);
  }
  return emit("model", out);
}

// The model with each stratum's position covariance scaled to reference-state
// errors: C'_ab = s_a s_b C_ab over the position rows and columns, with
// s_k = sqrt(E[e_k^2] / C_kk) (clipped second moment about zero of the
// reference errors). Strata with fewer reference samples than the minimum
// are left unscaled and say so.
extern "C" int scale_model() {
  nlohmann::json model = json_input("model");
  const nlohmann::json truth = json_input("truth");
  if (!model.is_object() || model.value("kind", std::string()) != "gp-error-model" || !model.contains("strata"))
    return fail("invalid-model", "model must be gp-error-model JSON.");
  if (!truth.is_object() || truth.value("kind", std::string()) != "gp-error-model" ||
      truth.value("mode", std::string()) != "reference" || !truth.contains("strata"))
    return fail("invalid-truth", "truth must be gp-error-model JSON in reference mode.");
  if (options_signature(model) != options_signature(truth))
    return fail("invalid-truth", "truth regimes or age bins differ from the model's.");
  double min_samples = 30;
  if (input("options")) {
    const nlohmann::json o = json_input("options");
    if (o.is_object() && o.contains("minimumSamples")) {
      if (!o["minimumSamples"].is_number()) return fail("invalid-options", "minimumSamples must be a number.");
      min_samples = o["minimumSamples"].get<double>();
    }
  }
  const int pos[3][3] = {{0, 1, 3}, {1, 2, 4}, {3, 4, 5}};
  for (auto& s : model["strata"]) {
    const nlohmann::json* t = nullptr;
    for (const auto& x : truth["strata"])
      if (x["regimeIndex"] == s["regimeIndex"] && x["ageIndex"] == s["ageIndex"]) t = &x;
    nlohmann::json* target = s.contains("clipped") && s["clipped"].contains("covariance") ? &s["clipped"]["covariance"]
                             : s.contains("covariance") ? &s["covariance"] : nullptr;
    if (!t || !target || !(*t).contains("clipped") || !(*t)["clipped"].contains("covariance") ||
        (*t)["clipped"]["n"].get<double>() < min_samples) {
      s["scale"] = nullptr;
      continue;
    }
    const auto& tc = (*t)["clipped"]["covariance"];
    const auto& tm = (*t)["clipped"]["mean"];
    double f[6] = {1, 1, 1, 1, 1, 1};
    for (int k = 0; k < 3; ++k) {
      const double second = tc[pos[k][k]].get<double>() + tm[k].get<double>() * tm[k].get<double>();
      f[k] = std::sqrt(second / (*target)[pos[k][k]].get<double>());
    }
    for (nlohmann::json* c : {s.contains("covariance") ? &s["covariance"] : nullptr,
                              s.contains("clipped") && s["clipped"].contains("covariance") ? &s["clipped"]["covariance"] : nullptr}) {
      if (!c) continue;
      for (int a = 0, i = 0; a < kComponents; ++a)
        for (int b = 0; b <= a; ++b, ++i) (*c)[i] = (*c)[i].get<double>() * f[a] * f[b];
    }
    s["scale"] = {{"factors", {f[0], f[1], f[2]}}, {"truthN", (*t)["clipped"]["n"]}};
  }
  model["scale"] = {{"basis", "position covariance scaled per stratum to the clipped second moment about zero of "
                              "reference-state errors"},
                    {"truthCounts", truth.contains("counts") ? truth["counts"] : nlohmann::json()},
                    {"truthWindow", truth.contains("window") ? truth["window"] : nlohmann::json()},
                    {"minimumSamples", min_samples}};
  return emit("model", model);
}
