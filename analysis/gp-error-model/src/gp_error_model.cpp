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
// hpop_arcs / hpop_coverage: P0 and process noise for HPOP covariance, fitted and
// tested against reference states (section below).
// screening_evaluation: probabilistic, bounded-set and possibility screening
// scored on cases built from reference-state errors (section below).

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
bool parse_instant(const std::string& text, Instant* out, int* ymdhms = nullptr, double* second = nullptr) {
  if (text.size() < 19) return false;
  const char* t = text.c_str();
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
bool parse_instant(const flatbuffers::String* s, Instant* out, int* ymdhms = nullptr, double* second = nullptr) {
  return s && parse_instant(s->str(), out, ymdhms, second);
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
  // One zero-mean Mahalanobis distance; quantile holds the chi-square 3 quantiles at kContainment.
  void add(double d2, const double quantile[3], uint32_t norad) {
    ++n;
    sum_d2 += d2;
    for (int k = 0; k < 3; ++k) inside[k] += d2 <= quantile[k];
    ++pit[std::min(kPitBins - 1, static_cast<int>(chi2_cdf3(d2) * kPitBins))];
    objects.insert(norad);
  }
};

// The calibration gate.
struct Gate {
  double tolerance = 0.05, tail_limit = 0.01, min_samples = 30, min_objects = 3;
};
std::string read_gate(const nlohmann::json& options, Gate* gate) {
  const nlohmann::json g = options.is_object() && options.contains("gate") ? options["gate"] : nlohmann::json::object();
  if (!g.is_object()) return "gate must be an object.";
  for (auto [key, target] : {std::pair<const char*, double*>{"tolerance", &gate->tolerance}, {"tailLimit", &gate->tail_limit},
                             {"minimumSamples", &gate->min_samples}, {"minimumObjects", &gate->min_objects}}) {
    if (!g.contains(key)) continue;
    if (!g[key].is_number() || !(g[key].get<double>() >= 0)) return "gate values are non-negative numbers.";
    *target = g[key].get<double>();
  }
  return {};
}
nlohmann::json gate_json(const Gate& gate) {
  return {{"rule", "CALIBRATED when the fractions inside the 1 and 2 sigma ellipsoids are within the tolerance "
                   "of nominal and at most the tail limit lies outside 3 sigma, with at least the minimum "
                   "samples and distinct objects; every sample counts"},
          {"tolerance", gate.tolerance}, {"tailLimit", gate.tail_limit}, {"minimumSamples", gate.min_samples},
          {"minimumObjects", gate.min_objects},
          {"nominal", std::vector<double>(std::begin(kContainment), std::end(kContainment))}};
}
// Containment, mean d^2, PIT histogram and the gate's status.
nlohmann::json coverage_json(const Coverage& c, const Gate& gate) {
  nlohmann::json g{{"n", c.n}, {"objects", c.objects.size()}};
  if (!c.n) {
    g["status"] = c.missing ? "NO_MODEL" : "INSUFFICIENT";
    return g;
  }
  const double n = static_cast<double>(c.n);
  std::vector<double> inside(3), pit(kPitBins);
  bool within = true;
  for (int k = 0; k < 3; ++k) inside[k] = c.inside[k] / n;
  for (int k = 0; k < 2; ++k) within = within && std::fabs(inside[k] - kContainment[k]) <= gate.tolerance;
  within = within && 1.0 - inside[2] <= gate.tail_limit;
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
  g["status"] = n < gate.min_samples || c.objects.size() < gate.min_objects ? "INSUFFICIENT" : within ? "CALIBRATED" : "FAILED";
  return g;
}

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
  int ymdhm[5] = {};
  double second = 0;
  std::string epoch_text;
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
          !parse_instant(omm->EPOCH(), &s.epoch, s.ymdhm, &s.second)) {
        ++counts.refused;
        continue;
      }
      s.epoch_text = omm->EPOCH()->str();
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
  // Screening evaluation: every reference-mode position error, kept.
  struct Kept {
    int regime, age;
    uint32_t norad;
    double e[3];
  };
  bool keep = false;
  std::vector<Kept> kept;
  size_t index(int regime, int age) const { return regime * options.ages.size() + age; }
  Stratum& at(int regime, int age) { return strata[index(regime, age)]; }
};

void sample(Accumulator& acc, int regime, int age, const double x[6], uint32_t norad) {
  const auto clip = acc.options.clip.find({regime, age});
  add_sample(acc.at(regime, age), x, clip == acc.options.clip.end() ? nullptr : &clip->second, acc.options.clip_k);
  ++acc.counts.samples;
  if (acc.keep) acc.kept.push_back({regime, age, norad, {x[0], x[1], x[2]}});
  if (acc.coverage_model.empty()) return;
  Coverage& c = acc.coverage[acc.index(regime, age)];
  const auto inv = acc.inverse.find({regime, age});
  if (inv == acc.inverse.end()) { ++c.missing; return; }
  double d2 = 0;
  for (int a = 0; a < 3; ++a)
    for (int b = 0; b < 3; ++b) d2 += x[a] * inv->second[3 * a + b] * x[b];
  c.add(d2, acc.quantile, norad);
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

// Every reference block, verified: $OEM, GCRF, UTC, a NORAD number and lines.
template <typename F>
std::string for_each_reference_block(F block) {
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
      const std::string e = block(b->OBJECT()->NORAD_CAT_ID(), *b->EPHEMERIS_DATA_LINES());
      if (!e.empty()) return e;
    }
  }
  return {};
}

std::string reference_errors(Accumulator& acc, std::vector<ElementSet>& sets) {
  std::map<std::string, fr::Mat3> teme;  // GCRF -> TEME per epoch
  const double max_s = acc.options.max_age_days * 86400.0;
  using Lines = flatbuffers::Vector<flatbuffers::Offset<ephemerisDataLine>>;
  return for_each_reference_block([&](uint32_t norad, const Lines& lines) -> std::string {
    const auto first = std::lower_bound(sets.begin(), sets.end(), norad,
                                        [](const ElementSet& s, uint32_t id) { return s.norad < id; });
    bool any = false;
    Instant kept{};
    bool have_kept = false;
    for (const ephemerisDataLine* l : lines) {
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
    return {};
  });
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
  Gate gate;
  if (input("options")) {
    e = read_gate(json_input("options"), &gate);
    if (!e.empty()) return fail("invalid-options", e);
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
    out["gate"] = gate_json(gate);
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
      nlohmann::json g = coverage_json(acc.coverage[i], gate);
      g["missingModel"] = acc.coverage[i].missing;
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

// ── Screening evaluation (ASO catalog paper sections 9 and 12) ──
// Independent cases from real errors: two reference-state errors of different
// objects in one stratum (regime, prediction age) are one encounter's two
// objects' errors; the true relative position is a synthetic miss m in the
// encounter plane, the predicted one is m plus the relative error. Encounter
// planes: head-on (radial, normal; the secondary's normal reversed) and
// crossing at 90 degrees (radial and (T+N)/sqrt2 for the primary, (T'-N')/
// sqrt2 in the secondary's own axes). Each object's 2x2 covariance is its
// stratum's position covariance projected to the plane. Methods:
//   probabilistic  Foster's Pc over the hard-body disk with C1 + C2; alert
//                  when Pc >= pcThreshold.
//   bounded set    the relative ellipse x' (C1+C2)^-1 x <= k^2 (2 dof, k^2 at
//                  boundCoverage) around the prediction; alert when it comes
//                  within the hard-body radius of the origin.
//   possibility    per object pi(e) = 1 - F_chi2_3(e' C^-1 e) (the Gaussian
//                  probability-to-possibility transform on the 3D error, so
//                  its projection keeps chi-square 3 levels), joint
//                  possibility min(pi1, pi2) for independent objects;
//                  Pi(collision) = sup over collisions; N(no collision) =
//                  1 - Pi(collision); alert unless N(no collision) >=
//                  necessityLevel. The alpha-cut of the joint relative error
//                  is the Minkowski sum of the two ellipses, whose support
//                  function is sqrt(q) (|C1^1/2 u| + |C2^1/2 u|).
// Collision truth: |m| <= hard-body radius. Every case counts.
namespace screening {

struct Case2 {
  double p[2];        // predicted relative position, km
  double c1[3], c2[3];  // per-object plane covariance (xx, xy, yy), km^2
};

double quad(const double c[3], double ux, double uy) { return c[0] * ux * ux + 2 * c[1] * ux * uy + c[2] * uy * uy; }

// Foster: the 2D Gaussian N(p, C) over the disk |x| <= r, by Gauss-Legendre in
// radius (8 nodes) and the midpoint rule in angle (32).
double foster(const double p[2], const double c[3], double r) {
  static const double gx[8] = {-0.9602898564975363, -0.7966664774136267, -0.5255324099163290, -0.1834346424956498,
                               0.1834346424956498, 0.5255324099163290, 0.7966664774136267, 0.9602898564975363};
  static const double gw[8] = {0.1012285362903763, 0.2223810344533745, 0.3137066458778873, 0.3626837833783620,
                               0.3626837833783620, 0.3137066458778873, 0.2223810344533745, 0.1012285362903763};
  const double det = c[0] * c[2] - c[1] * c[1];
  if (!(det > 0)) return 0;
  const double i00 = c[2] / det, i01 = -c[1] / det, i11 = c[0] / det;
  double sum = 0;
  for (int a = 0; a < 8; ++a) {
    const double rho = 0.5 * r * (gx[a] + 1);
    for (int b = 0; b < 32; ++b) {
      const double th = (b + 0.5) * 2 * kPi / 32;
      const double dx = rho * std::cos(th) - p[0], dy = rho * std::sin(th) - p[1];
      sum += gw[a] * 0.5 * r * rho * (2 * kPi / 32) * std::exp(-0.5 * (i00 * dx * dx + 2 * i01 * dx * dy + i11 * dy * dy));
    }
  }
  return sum / (2 * kPi * std::sqrt(det));
}

// max over unit u of f(u), 720 directions then a parabolic step.
template <typename F>
double maximize(F f) {
  double best = -1e300, at = 0;
  for (int k = 0; k < 720; ++k) {
    const double th = k * kPi / 360, v = f(std::cos(th), std::sin(th));
    if (v > best) { best = v; at = th; }
  }
  const double h = kPi / 360, a = f(std::cos(at - h), std::sin(at - h)), b = f(std::cos(at + h), std::sin(at + h));
  const double den = a - 2 * best + b;
  if (den < 0) {
    const double t = at + 0.5 * h * (a - b) / den;
    best = std::max(best, f(std::cos(t), std::sin(t)));
  }
  return best;
}

// Distance from p to the ellipse x' C^-1 x <= k^2 (0 inside).
double ellipse_distance(const double p[2], const double c[3], double k) {
  return std::max(0.0, maximize([&](double ux, double uy) { return ux * p[0] + uy * p[1] - k * std::sqrt(quad(c, ux, uy)); }));
}

// Pi(collision) for the min-joined possibility of two objects, chi-square 3.
double possibility(const Case2& c, double r) {
  if (std::hypot(c.p[0], c.p[1]) <= r) return 1.0;
  const double s = maximize([&](double ux, double uy) {
    const double g = std::sqrt(quad(c.c1, ux, uy)) + std::sqrt(quad(c.c2, ux, uy));
    return g > 0 ? (ux * c.p[0] + uy * c.p[1] - r) / g : -1e300;
  });
  return s <= 0 ? 1.0 : 1.0 - chi2_cdf3(s * s);
}

struct Tally {
  uint64_t cases = 0, pc_alerts = 0, bound_alerts = 0, possibility_alerts = 0;
  double pc_sum = 0, possibility_sum = 0, brier = 0;
};

}  // namespace screening

extern "C" int screening_evaluation() {
  using namespace screening;
  const nlohmann::json model = json_input("model");
  if (!model.is_object() || model.value("kind", std::string()) != "gp-error-model" || !model.contains("strata"))
    return fail("invalid-model", "model must be gp-error-model JSON.");
  const nlohmann::json opt = input("options") ? json_input("options") : nlohmann::json::object();
  Accumulator acc;
  std::string e = parse_options(opt, &acc.options);
  if (!e.empty()) return fail("invalid-options", e);
  if (options_signature(model) != options_signature(options_json(acc.options)))
    return fail("invalid-model", "model regimes or age bins differ from these options.");
  auto number = [&](const char* key, double fallback) {
    return opt.is_object() && opt.contains(key) && opt[key].is_number() ? opt[key].get<double>() : fallback;
  };
  const double radius = number("hardBodyRadiusM", 20) * 1e-3, pc_threshold = number("pcThreshold", 1e-4);
  const double necessity_level = number("necessityLevel", 0.9973), bound_coverage = number("boundCoverage", 0.9973);
  const size_t pairs_per_stratum = static_cast<size_t>(number("pairsPerStratum", 500));
  const int directions = static_cast<int>(number("directions", 4));
  uint64_t seed = static_cast<uint64_t>(number("seed", 1));
  std::vector<double> misses = {0, 10, 50, 100, 500, 1000, 2000, 5000};
  if (opt.is_object() && opt.contains("missDistancesM") && opt["missDistancesM"].is_array()) {
    misses.clear();
    for (const auto& m : opt["missDistancesM"])
      if (m.is_number()) misses.push_back(m.get<double>());
  }
  if (!(radius > 0) || directions < 1 || misses.empty() || !(bound_coverage > 0 && bound_coverage < 1))
    return fail("invalid-options", "hardBodyRadiusM, directions, missDistancesM and boundCoverage must be valid.");
  const double bound_k = std::sqrt(-2.0 * std::log(1.0 - bound_coverage));  // chi-square 2 quantile

  acc.strata.assign(acc.options.regimes.size() * acc.options.ages.size(), Stratum());
  acc.mode = "reference";
  acc.keep = true;
  std::vector<ElementSet> sets;
  if (!load_elements(acc.options, sets, acc.counts)) return fail("invalid-elements", error_text);
  e = reference_errors(acc, sets);
  if (!e.empty()) return fail("invalid-reference", e);

  // Stratum covariances (position block, clipped when present).
  std::map<std::pair<int, int>, std::array<double, 9>> cov;
  for (const auto& st : model["strata"]) {
    const nlohmann::json& c = st.contains("clipped") && st["clipped"].contains("covariance") ? st["clipped"]["covariance"]
                              : st.contains("covariance") ? st["covariance"] : nlohmann::json();
    if (!c.is_array() || c.size() != 21) continue;
    const int idx[3][3] = {{0, 1, 3}, {1, 2, 4}, {3, 4, 5}};
    std::array<double, 9> m;
    for (int a = 0; a < 3; ++a)
      for (int b = 0; b < 3; ++b) m[3 * a + b] = c[idx[a][b]].get<double>();
    cov[{st["regimeIndex"].get<int>(), st["ageIndex"].get<int>()}] = m;
  }
  auto project = [](const std::array<double, 9>& m, const double a[2][3], double out[3]) {
    double t[2][3] = {};
    for (int i = 0; i < 2; ++i)
      for (int j = 0; j < 3; ++j)
        for (int k = 0; k < 3; ++k) t[i][j] += a[i][k] * m[3 * k + j];
    double r[2][2] = {};
    for (int i = 0; i < 2; ++i)
      for (int j = 0; j < 2; ++j)
        for (int k = 0; k < 3; ++k) r[i][j] += t[i][k] * a[j][k];
    out[0] = r[0][0]; out[1] = r[0][1]; out[2] = r[1][1];
  };
  const double h = 1.0 / std::sqrt(2.0);
  // geometry -> (primary axes, secondary axes) in each object's own RTN
  const double geometries[2][2][2][3] = {
      {{{1, 0, 0}, {0, 0, 1}}, {{1, 0, 0}, {0, 0, -1}}},  // head-on
      {{{1, 0, 0}, {0, h, h}}, {{1, 0, 0}, {0, h, -h}}},  // crossing at 90 degrees
  };
  const char* geometry_names[2] = {"head-on", "crossing-90"};

  std::map<std::pair<int, int>, std::vector<const Accumulator::Kept*>> by_stratum;
  for (const auto& k : acc.kept) by_stratum[{k.regime, k.age}].push_back(&k);
  auto next = [&]() {  // splitmix64
    seed += 0x9e3779b97f4a7c15ULL;
    uint64_t z = seed;
    z = (z ^ (z >> 30)) * 0xbf58476d1ce4e5b9ULL;
    z = (z ^ (z >> 27)) * 0x94d049bb133111ebULL;
    return z ^ (z >> 31);
  };

  nlohmann::json out_strata = nlohmann::json::array();
  std::map<std::string, std::vector<Tally>> overall;  // geometry -> per miss
  for (auto& [key, samples] : by_stratum) {
    const auto c = cov.find(key);
    if (c == cov.end()) continue;
    std::set<uint32_t> objects;
    for (const auto* s : samples) objects.insert(s->norad);
    if (objects.size() < 2) continue;
    // Pairs of samples of different objects, drawn without replacement order.
    std::vector<std::pair<const Accumulator::Kept*, const Accumulator::Kept*>> pairs;
    for (size_t tries = 0; pairs.size() < pairs_per_stratum && tries < pairs_per_stratum * 20; ++tries) {
      const auto* a = samples[next() % samples.size()];
      const auto* b = samples[next() % samples.size()];
      if (a->norad != b->norad) pairs.push_back({a, b});
    }
    nlohmann::json geometry_rows = nlohmann::json::array();
    for (int g = 0; g < 2; ++g) {
      double c1[3], c2[3];
      project(c->second, geometries[g][0], c1);
      project(c->second, geometries[g][1], c2);
      const double crel[3] = {c1[0] + c2[0], c1[1] + c2[1], c1[2] + c2[2]};
      std::vector<Tally> tallies(misses.size());
      for (const auto& [a, b] : pairs) {
        double e1[2], e2[2];
        for (int i = 0; i < 2; ++i) {
          e1[i] = geometries[g][0][i][0] * a->e[0] + geometries[g][0][i][1] * a->e[1] + geometries[g][0][i][2] * a->e[2];
          e2[i] = geometries[g][1][i][0] * b->e[0] + geometries[g][1][i][1] * b->e[1] + geometries[g][1][i][2] * b->e[2];
        }
        for (size_t mi = 0; mi < misses.size(); ++mi) {
          const double m = misses[mi] * 1e-3;
          const bool collision = m <= radius;
          for (int d = 0; d < directions; ++d) {
            const double phi = (d + 0.5) * 2 * kPi / directions;
            Case2 cs{{m * std::cos(phi) + e2[0] - e1[0], m * std::sin(phi) + e2[1] - e1[1]},
                     {c1[0], c1[1], c1[2]}, {c2[0], c2[1], c2[2]}};
            Tally& t = tallies[mi];
            const double pc = foster(cs.p, crel, radius);
            const double pi = possibility(cs, radius);
            ++t.cases;
            t.pc_sum += pc;
            t.brier += (pc - (collision ? 1.0 : 0.0)) * (pc - (collision ? 1.0 : 0.0));
            t.pc_alerts += pc >= pc_threshold;
            t.bound_alerts += ellipse_distance(cs.p, crel, bound_k) <= radius;
            t.possibility_sum += pi;
            t.possibility_alerts += 1.0 - pi < necessity_level;
          }
        }
      }
      auto& all = overall[geometry_names[g]];
      if (all.empty()) all.resize(misses.size());
      nlohmann::json rows = nlohmann::json::array();
      for (size_t mi = 0; mi < misses.size(); ++mi) {
        const Tally& t = tallies[mi];
        Tally& o = all[mi];
        o.cases += t.cases; o.pc_alerts += t.pc_alerts; o.bound_alerts += t.bound_alerts;
        o.possibility_alerts += t.possibility_alerts; o.pc_sum += t.pc_sum; o.possibility_sum += t.possibility_sum;
        o.brier += t.brier;
        const double n = t.cases ? double(t.cases) : 1.0;
        rows.push_back({{"missM", misses[mi]}, {"collision", misses[mi] * 1e-3 <= radius}, {"cases", t.cases},
                        {"pcAlertRate", t.pc_alerts / n}, {"meanPc", t.pc_sum / n}, {"brier", t.brier / n},
                        {"boundedSetAlertRate", t.bound_alerts / n}, {"possibilityAlertRate", t.possibility_alerts / n},
                        {"meanPossibilityOfCollision", t.possibility_sum / n}});
      }
      geometry_rows.push_back({{"geometry", geometry_names[g]}, {"rows", rows}});
    }
    out_strata.push_back({{"regime", acc.options.regimes[key.first].id}, {"regimeIndex", key.first}, {"ageIndex", key.second},
                          {"ageDays", {acc.options.ages[key.second].first, acc.options.ages[key.second].second}},
                          {"objects", objects.size()}, {"samples", samples.size()}, {"pairs", pairs.size()},
                          {"sigmaRtnKm", {std::sqrt(c->second[0]), std::sqrt(c->second[4]), std::sqrt(c->second[8])}},
                          {"geometries", geometry_rows}});
  }
  nlohmann::json summary = nlohmann::json::object();
  for (const auto& [name, tallies] : overall) {
    nlohmann::json rows = nlohmann::json::array();
    for (size_t mi = 0; mi < misses.size(); ++mi) {
      const Tally& t = tallies[mi];
      const double n = t.cases ? double(t.cases) : 1.0;
      rows.push_back({{"missM", misses[mi]}, {"collision", misses[mi] * 1e-3 <= radius}, {"cases", t.cases},
                      {"pcAlertRate", t.pc_alerts / n}, {"meanPc", t.pc_sum / n}, {"brier", t.brier / n},
                      {"boundedSetAlertRate", t.bound_alerts / n}, {"possibilityAlertRate", t.possibility_alerts / n},
                      {"meanPossibilityOfCollision", t.possibility_sum / n}});
    }
    summary[name] = rows;
  }
  nlohmann::json report{
      {"kind", "screening-evaluation"}, {"version", 1}, {"counts", counts_json(acc.counts)},
      {"definitions",
       {{"cases", "two reference-state errors of different objects in one stratum; true miss synthetic, predicted = true + relative error"},
        {"collision", "true miss <= hard-body radius"},
        {"probabilistic", "alert when Foster Pc >= pcThreshold, relative covariance C1 + C2"},
        {"boundedSet", "alert when the relative ellipse at boundCoverage (chi-square 2) comes within the radius"},
        {"possibility", "pi = 1 - F_chi2_3(d^2) per object, joint min; alert unless N(no collision) >= necessityLevel"},
        {"missedCollision", "a collision case without an alert"},
        {"falseAlert", "a non-collision case with an alert"}}},
      {"settings",
       {{"hardBodyRadiusM", radius * 1e3}, {"pcThreshold", pc_threshold}, {"necessityLevel", necessity_level},
        {"boundCoverage", bound_coverage}, {"pairsPerStratum", pairs_per_stratum}, {"directions", directions},
        {"missDistancesM", misses}}},
      {"summary", summary}, {"strata", out_strata}};
  return emit("report", report);
}

// ── HPOP covariance calibration ──
// The product calibrated is the CA HPOP screen's: analysis/epoch-state's GCRF
// state at an element set's epoch, propagated by propagator/hpop's resident
// force model, with covariance P(t) = Phi P0 Phi^T + Q. The host runs HPOP;
// these methods choose where to compare, supply P0 and score P(t).
//   hpop_arcs      per element set (an arc): at each requested prediction age
//                  the reference epoch nearest it (for age 0, the first
//                  reference epoch at or after the set's epoch) and the
//                  reference state there; with a model, P0 in GCRF (SI) and
//                  the regime's process noise.
//   hpop_coverage  scores HPOP's states and covariances at those targets.
//     epoch  P0 per regime: the second moment about zero of the 6-D RTN error
//            at age 0. Samples beyond k robust sigma (1.4826 x median |x|)
//            in any component are left out, and counted.
//     fit    white-acceleration spectral densities (R, T, N) per regime by
//            maximum likelihood over the position errors at ages above 0:
//            P = A + sum_k q_k U_k, where A is HPOP's covariance from P0
//            alone and U_k from P0 = 0 with unit density on axis k (P(t) is
//            linear in P0 and Q). Coordinate search on log10 q in [-22, -2],
//            -22 meaning zero. Likelihood and containment can disagree, so
//            the regime keeps Q = 0 when P0 alone passes the gate in more of
//            the fit window's strata; the test window plays no part.
//     test   zero-mean d^2 = e' P^-1 e against chi-square 3, by regime and
//            prediction age, every sample counted, with the calibration gate;
//            P0 alone (Q = 0) alongside.
namespace hpopcal {

struct RefLine {
  Instant t;
  std::string iso;
  double x[6];
};
using RefMap = std::map<uint32_t, std::vector<RefLine>>;

std::string load_references(RefMap& refs) {
  using Lines = flatbuffers::Vector<flatbuffers::Offset<ephemerisDataLine>>;
  const std::string e = for_each_reference_block([&](uint32_t norad, const Lines& lines) -> std::string {
    auto& list = refs[norad];
    for (const ephemerisDataLine* l : lines) {
      RefLine r;
      if (!parse_instant(l->EPOCH(), &r.t)) return "reference epoch is not ISO 8601 UTC.";
      r.iso = l->EPOCH()->str();
      const double x[6] = {l->X(), l->Y(), l->Z(), l->X_DOT(), l->Y_DOT(), l->Z_DOT()};
      std::copy(x, x + 6, r.x);
      list.push_back(r);
    }
    return {};
  });
  for (auto& entry : refs)
    std::stable_sort(entry.second.begin(), entry.second.end(),
                     [](const RefLine& a, const RefLine& b) { return before(a.t, b.t); });
  return e;
}

Instant plus_seconds(Instant t, double seconds) {
  t.sec += seconds;
  const double days = std::floor(t.sec / 86400.0);
  t.day += static_cast<int64_t>(days);
  t.sec -= days * 86400.0;
  return t;
}

// SGP4's TEME state at zero elapsed time, in GCRF.
bool gcrf_epoch_state(const ElementSet& s, double r[3], double v[3]) {
  fr::EarthOrientation none;  // TEME <-> GCRF needs TT only
  fr::Epoch e;
  if (!fr::epochFromUtc(s.ymdhm[0], s.ymdhm[1], s.ymdhm[2], s.ymdhm[3], s.ymdhm[4], s.second, none, &e)) return false;
  const fr::Mat3 m = fr::gcrfToTeme(e);
  for (int a = 0; a < 3; ++a) {
    r[a] = m.m[0][a] * s.r[0] + m.m[1][a] * s.r[1] + m.m[2][a] * s.r[2];
    v[a] = m.m[0][a] * s.v[0] + m.m[1][a] * s.v[1] + m.m[2][a] * s.v[2];
  }
  return true;
}

// Rows R, T, N of a state's RTN axes (as rtn_error uses them).
void rtn_axes(const double r[3], const double v[3], double axes[3][3]) {
  const double rn = std::sqrt(r[0] * r[0] + r[1] * r[1] + r[2] * r[2]);
  double n[3] = {r[1] * v[2] - r[2] * v[1], r[2] * v[0] - r[0] * v[2], r[0] * v[1] - r[1] * v[0]};
  const double nn = std::sqrt(n[0] * n[0] + n[1] * n[1] + n[2] * n[2]);
  for (int k = 0; k < 3; ++k) {
    axes[0][k] = r[k] / rn;
    axes[2][k] = n[k] / nn;
  }
  axes[1][0] = axes[2][1] * axes[0][2] - axes[2][2] * axes[0][1];
  axes[1][1] = axes[2][2] * axes[0][0] - axes[2][0] * axes[0][2];
  axes[1][2] = axes[2][0] * axes[0][1] - axes[2][1] * axes[0][0];
}

// A lower-triangle RTN covariance (km, km/s) as a row-major 6x6 GCRF one in
// SI: G = J P J' with J = diag(A', A'), A the RTN rows.
std::vector<double> rtn_to_gcrf_si(const std::array<double, 21>& lower, const double axes[3][3]) {
  double p[6][6], j[6][6] = {}, jp[6][6] = {};
  for (int a = 0, t = 0; a < 6; ++a)
    for (int b = 0; b <= a; ++b, ++t) p[a][b] = p[b][a] = lower[t];
  for (int blk = 0; blk < 2; ++blk)
    for (int i = 0; i < 3; ++i)
      for (int k = 0; k < 3; ++k) j[3 * blk + i][3 * blk + k] = axes[k][i];
  for (int a = 0; a < 6; ++a)
    for (int b = 0; b < 6; ++b)
      for (int k = 0; k < 6; ++k) jp[a][b] += j[a][k] * p[k][b];
  std::vector<double> out(36, 0.0);
  for (int a = 0; a < 6; ++a)
    for (int b = 0; b <= a; ++b) {  // exactly symmetric: the lower triangle, mirrored
      double g = 0;
      for (int k = 0; k < 6; ++k) g += jp[a][k] * j[b][k];
      out[6 * a + b] = out[6 * b + a] = g * 1e6;  // km^2 -> m^2, (km/s)^2 -> (m/s)^2, km^2/s -> m^2/s
    }
  return out;
}

struct Model {
  nlohmann::json json;
  std::map<int, std::array<double, 21>> p0;
  std::map<int, std::array<double, 3>> q;
  std::map<int, double> interval;
};
std::string read_model(const nlohmann::json& j, const Options& options, Model* m) {
  if (!j.is_object() || j.value("kind", std::string()) != "hpop-covariance-model" || !j.contains("regimes") ||
      !j["regimes"].is_array())
    return "model must be hpop-covariance-model JSON.";
  m->json = j;
  for (const auto& r : j["regimes"]) {
    if (!r.is_object() || !r.contains("regimeIndex") || !r["regimeIndex"].is_number_integer()) return "each model regime needs regimeIndex.";
    const int index = r["regimeIndex"].get<int>();
    if (index < 0 || index >= static_cast<int>(options.regimes.size()) || r.value("regime", std::string()) != options.regimes[index].id)
      return "model regimes differ from these options.";
    if (r.contains("p0")) {
      if (!r["p0"].is_array() || r["p0"].size() != 21) return "p0 is a 21-entry lower triangle.";
      std::array<double, 21> p;
      for (int k = 0; k < 21; ++k) {
        if (!r["p0"][k].is_number()) return "p0 entries are numbers.";
        p[k] = r["p0"][k].get<double>();
      }
      m->p0[index] = p;
    }
    if (r.contains("processNoise")) {
      const auto& n = r["processNoise"];
      if (!n.is_object() || !n.contains("spectralDensityM2S3") || !n["spectralDensityM2S3"].is_array() ||
          n["spectralDensityM2S3"].size() != 3 || !n.contains("discretizationSeconds") || !n["discretizationSeconds"].is_number() ||
          !(n["discretizationSeconds"].get<double>() > 0))
        return "processNoise needs spectralDensityM2S3 [R, T, N] and discretizationSeconds > 0.";
      std::array<double, 3> q;
      for (int k = 0; k < 3; ++k) {
        if (!n["spectralDensityM2S3"][k].is_number() || !(n["spectralDensityM2S3"][k].get<double>() >= 0))
          return "spectral densities are non-negative numbers.";
        q[k] = n["spectralDensityM2S3"][k].get<double>();
      }
      m->q[index] = q;
      m->interval[index] = n["discretizationSeconds"].get<double>();
    }
  }
  return {};
}

double number(const nlohmann::json& o, const char* key, double fallback) {
  return o.is_object() && o.contains(key) && o[key].is_number() ? o[key].get<double>() : fallback;
}

// Symmetric 3x3 from (xx, xy, xz, yy, yz, zz): ln det and e' P^-1 e; false unless positive definite.
bool gauss_terms(const double p[6], const double e[3], double* logdet, double* d2) {
  const double a = p[0], b = p[1], c = p[2], d = p[3], f = p[4], g = p[5];
  const double c00 = d * g - f * f, c01 = c * f - b * g, c02 = b * f - c * d;
  const double det = a * c00 + b * c01 + c * c02;
  if (!(a > 0) || !(a * d - b * b > 0) || !(det > 0)) return false;
  const double c11 = a * g - c * c, c12 = b * c - a * f, c22 = a * d - b * b;
  *d2 = (e[0] * (c00 * e[0] + c01 * e[1] + c02 * e[2]) + e[1] * (c01 * e[0] + c11 * e[1] + c12 * e[2]) +
         e[2] * (c02 * e[0] + c12 * e[1] + c22 * e[2])) / det;
  *logdet = std::log(det);
  return true;
}

struct Sample {
  int regime = -1;
  uint32_t norad = 0;
  double nominal = 0, age = 0;
  double rtn[6];       // km, km/s, in the reference state's RTN axes
  double e[3];         // GCRF position error, m
  double axes[3][3];   // the reference state's RTN rows
  bool covariance = false;
  double a[6], u[3][6];  // position blocks, m^2
};

}  // namespace hpopcal

extern "C" int hpop_arcs() {
  using namespace hpopcal;
  const nlohmann::json opt = input("options") ? json_input("options") : nlohmann::json::object();
  if (!opt.is_object()) return fail("invalid-options", "options must be a JSON object.");
  Accumulator acc;
  std::string e = parse_options(opt, &acc.options);
  if (!e.empty()) return fail("invalid-options", e);
  std::vector<double> ages = {0, 0.25, 0.75, 1.5, 2.5, 4, 6};
  if (opt.contains("targetAgesDays")) {
    if (!opt["targetAgesDays"].is_array() || opt["targetAgesDays"].empty()) return fail("invalid-options", "targetAgesDays is a non-empty array.");
    ages.clear();
    for (const auto& a : opt["targetAgesDays"]) {
      if (!a.is_number() || !(a.get<double>() >= 0)) return fail("invalid-options", "target ages are non-negative days.");
      ages.push_back(a.get<double>());
    }
  }
  const double epoch_tol = number(opt, "epochToleranceSeconds", 1800), target_tol = number(opt, "targetToleranceSeconds", 900);
  Model model;
  const bool have_model = input("model") != nullptr;
  if (have_model) {
    e = read_model(json_input("model"), acc.options, &model);
    if (!e.empty()) return fail("invalid-model", e);
  }
  std::vector<ElementSet> sets;
  if (!load_elements(acc.options, sets, acc.counts)) return fail("invalid-elements", error_text);
  RefMap refs;
  e = load_references(refs);
  if (!e.empty()) return fail("invalid-reference", e);

  nlohmann::json arcs = nlohmann::json::array();
  uint64_t targets = 0, without_reference = 0, without_targets = 0, without_model = 0;
  const auto earlier = [](const RefLine& r, const Instant& t) { return before(r.t, t); };
  for (const ElementSet& s : sets) {
    const auto found = refs.find(s.norad);
    if (found == refs.end()) { ++without_reference; continue; }
    const std::vector<RefLine>& list = found->second;
    nlohmann::json list_json = nlohmann::json::array();
    for (double a : ages) {
      const RefLine* best = nullptr;
      if (a == 0) {
        const auto f = std::lower_bound(list.begin(), list.end(), s.epoch, earlier);
        if (f != list.end() && seconds_between(s.epoch, f->t) <= epoch_tol) best = &*f;
      } else {
        const Instant goal = plus_seconds(s.epoch, a * 86400.0);
        const auto f = std::lower_bound(list.begin(), list.end(), goal, earlier);
        double gap = target_tol;
        for (auto c : {f, f == list.begin() ? list.end() : f - 1}) {
          if (c == list.end() || !(seconds_between(s.epoch, c->t) > 0)) continue;
          const double d = std::fabs(seconds_between(goal, c->t));
          if (d <= gap) { gap = d; best = &*c; }
        }
      }
      if (!best) continue;
      list_json.push_back({{"nominalDays", a}, {"ageDays", seconds_between(s.epoch, best->t) / 86400.0},
                           {"epoch", best->iso}, {"truth", std::vector<double>(best->x, best->x + 6)}});
    }
    if (list_json.empty()) { ++without_targets; continue; }
    nlohmann::json arc{{"arc", arcs.size()}, {"norad", s.norad}, {"epoch", s.epoch_text}, {"regimeIndex", s.regime},
                       {"regime", acc.options.regimes[s.regime].id}, {"targets", list_json}};
    if (have_model) {
      const auto p0 = model.p0.find(s.regime);
      if (p0 == model.p0.end()) {
        ++without_model;
      } else {
        double r[3], v[3], axes[3][3];
        if (!gcrf_epoch_state(s, r, v)) return fail("invalid-elements", "element-set epoch outside the leap-second table.");
        rtn_axes(r, v, axes);
        arc["covariance"] = rtn_to_gcrf_si(p0->second, axes);
        const auto q = model.q.find(s.regime);
        if (q != model.q.end())
          arc["processNoise"] = {{"spectralDensityM2S3", q->second}, {"axes", "RADIAL_TRANSVERSE_NORMAL"},
                                 {"discretizationSeconds", model.interval[s.regime]}};
      }
    }
    targets += list_json.size();
    arcs.push_back(arc);
  }
  nlohmann::json counts = counts_json(acc.counts);
  counts["arcs"] = arcs.size();
  counts["targets"] = targets;
  counts["setsWithoutReference"] = without_reference;
  counts["setsWithoutTargets"] = without_targets;
  counts["arcsWithoutModelRegime"] = without_model;
  return emit("plan", {{"kind", "hpop-arc-plan"}, {"version", 1}, {"targetAgesDays", ages},
                       {"epochToleranceSeconds", epoch_tol}, {"targetToleranceSeconds", target_tol},
                       {"covariance", "row-major 6x6 GCRF, SI (m, m/s), from the model's RTN P0 at the set's epoch"},
                       {"truth", "reference state, GCRF, km and km/s"}, {"counts", counts}, {"arcs", arcs}});
}

extern "C" int hpop_coverage() {
  using namespace hpopcal;
  const nlohmann::json plan = json_input("plan"), predictions = json_input("predictions");
  if (!plan.is_object() || plan.value("kind", std::string()) != "hpop-arc-plan" || !plan.contains("arcs"))
    return fail("invalid-plan", "plan must be hpop-arc-plan JSON.");
  if (!predictions.is_object() || !predictions.contains("arcs") || !predictions["arcs"].is_array())
    return fail("invalid-predictions", "predictions need arcs [{arc, samples}].");
  const nlohmann::json opt = input("options") ? json_input("options") : nlohmann::json::object();
  if (!opt.is_object()) return fail("invalid-options", "options must be a JSON object.");
  const std::string mode = opt.value("mode", std::string());
  if (mode != "epoch" && mode != "fit" && mode != "test") return fail("invalid-options", "mode is epoch, fit or test.");
  Options options;
  std::string e = parse_options(opt, &options);
  if (!e.empty()) return fail("invalid-options", e);
  Gate gate;
  e = read_gate(opt, &gate);
  if (!e.empty()) return fail("invalid-options", e);
  Instant from, to;
  if (!opt.contains("window") || !opt["window"].is_array() || opt["window"].size() != 2 || !opt["window"][0].is_string() ||
      !opt["window"][1].is_string() || !parse_instant(opt["window"][0].get<std::string>(), &from) ||
      !parse_instant(opt["window"][1].get<std::string>(), &to))
    return fail("invalid-options", "window is [from, to) as ISO 8601 UTC; it selects targets by epoch.");
  Model model;
  if (mode != "epoch") {
    if (!input("model")) return fail("invalid-model", "fit and test need the model.");
    e = read_model(json_input("model"), options, &model);
    if (!e.empty()) return fail("invalid-model", e);
  }

  // Samples: the plan's targets in the window that have a prediction.
  std::map<uint64_t, const nlohmann::json*> predicted;
  for (const auto& a : predictions["arcs"])
    if (a.is_object() && a.contains("arc") && a["arc"].is_number_unsigned() && a.contains("samples") && a["samples"].is_array())
      predicted[a["arc"].get<uint64_t>()] = &a;
  auto numbers = [](const nlohmann::json& j, size_t n, double* out) {
    if (!j.is_array() || j.size() != n) return false;
    for (size_t k = 0; k < n; ++k) {
      if (!j[k].is_number()) return false;
      out[k] = j[k].get<double>();
    }
    return true;
  };
  std::vector<Sample> samples;
  uint64_t outside = 0, unpredicted = 0;
  for (const auto& arc : plan["arcs"]) {
    const auto p = predicted.find(arc.value("arc", uint64_t(0)));
    const nlohmann::json& targets = arc["targets"];
    for (size_t j = 0; j < targets.size(); ++j) {
      Instant t;
      if (!parse_instant(targets[j].value("epoch", std::string()), &t)) return fail("invalid-plan", "target epochs are ISO 8601 UTC.");
      if (before(t, from) || !before(t, to)) { ++outside; continue; }
      if (p == predicted.end() || j >= (*p->second)["samples"].size() || (*p->second)["samples"][j].is_null()) { ++unpredicted; continue; }
      const nlohmann::json& got = (*p->second)["samples"][j];
      Sample s;
      s.regime = arc.value("regimeIndex", -1);
      s.norad = arc.value("norad", 0u);
      s.nominal = targets[j].value("nominalDays", 0.0);
      s.age = targets[j].value("ageDays", 0.0);
      double truth[6], state[6];
      if (s.regime < 0 || s.regime >= static_cast<int>(options.regimes.size()) || !numbers(targets[j]["truth"], 6, truth) ||
          !got.contains("state") || !numbers(got["state"], 6, state))
        return fail("invalid-predictions", "each sample needs state [6] (m, m/s) against the plan's truth.");
      const double rp[3] = {state[0] / 1e3, state[1] / 1e3, state[2] / 1e3}, vp[3] = {state[3] / 1e3, state[4] / 1e3, state[5] / 1e3};
      rtn_error(rp, vp, truth, truth + 3, s.rtn);
      rtn_axes(truth, truth + 3, s.axes);
      for (int k = 0; k < 3; ++k) s.e[k] = state[k] - truth[k] * 1e3;
      if (got.contains("a")) {
        if (!numbers(got["a"], 6, s.a) || !got.contains("u") || !got["u"].is_array() || got["u"].size() != 3 ||
            !numbers(got["u"][0], 6, s.u[0]) || !numbers(got["u"][1], 6, s.u[1]) || !numbers(got["u"][2], 6, s.u[2]))
          return fail("invalid-predictions", "covariance samples carry a [6] and u [3][6] position blocks (m^2).");
        s.covariance = true;
      }
      samples.push_back(s);
    }
  }
  nlohmann::json counts{{"samples", samples.size()}, {"targetsOutsideWindow", outside}, {"targetsWithoutPrediction", unpredicted}};
  nlohmann::json window{opt["window"][0], opt["window"][1]};

  if (mode == "epoch") {
    const double clip_k = number(opt, "clipK", 5);
    std::map<int, std::vector<const Sample*>> by;
    for (const Sample& s : samples)
      if (s.nominal == 0) by[s.regime].push_back(&s);
    nlohmann::json regimes = nlohmann::json::array();
    for (const auto& [regime, list] : by) {
      double scale[6];
      for (int k = 0; k < 6; ++k) {
        std::vector<double> v;
        for (const Sample* s : list) v.push_back(std::fabs(s->rtn[k]));
        std::nth_element(v.begin(), v.begin() + v.size() / 2, v.end());
        scale[k] = 1.4826 * v[v.size() / 2];
      }
      std::array<double, 21> p0{};
      std::set<uint32_t> objects;
      uint64_t kept = 0;
      for (const Sample* s : list) {
        bool in = true;
        for (int k = 0; k < 6; ++k) in = in && (!(scale[k] > 0) || std::fabs(s->rtn[k]) <= clip_k * scale[k]);
        if (!in) continue;
        ++kept;
        objects.insert(s->norad);
        for (int a = 0, t = 0; a < 6; ++a)
          for (int b = 0; b <= a; ++b, ++t) p0[t] += s->rtn[a] * s->rtn[b];
      }
      if (kept < 2) continue;
      for (double& x : p0) x /= static_cast<double>(kept);
      regimes.push_back({{"regimeIndex", regime}, {"regime", options.regimes[regime].id}, {"n", list.size()}, {"kept", kept},
                         {"objects", objects.size()}, {"clipK", clip_k}, {"p0", p0}});
    }
    return emit("model", {{"kind", "hpop-covariance-model"}, {"version", 1},
                          {"basis", "P0: second moment about zero of HPOP's error at its first reference epoch after the "
                                    "element set's epoch, against independent reference states, per regime"},
                          {"units", {{"p0", "km, km/s; lower triangle, row-major, RTN: RR, TR, TT, NR, NT, NN, dR R, ..."},
                                     {"spectralDensityM2S3", "m^2/s^3 per R, T, N axis"}}},
                          {"epochWindow", window}, {"counts", counts}, {"regimes", regimes}});
  }

  if (mode == "fit") {
    std::map<int, std::vector<const Sample*>> by, all;
    for (const Sample& s : samples) {
      if (s.covariance) all[s.regime].push_back(&s);
      if (s.nominal > 0 && s.covariance) by[s.regime].push_back(&s);
    }
    const double quantile[3] = {chi2_quantile3(kContainment[0]), chi2_quantile3(kContainment[1]), chi2_quantile3(kContainment[2])};
    // Fit-week strata (every age) that pass the gate with these densities.
    auto passing = [&](const std::vector<const Sample*>& list, const double q[3]) {
      std::vector<Coverage> bins(options.ages.size());
      for (const Sample* s : list) {
        const int bin = age_of(options, s->age);
        if (bin < 0) continue;
        double p[6], logdet, d2;
        for (int c = 0; c < 6; ++c) p[c] = s->a[c] + q[0] * s->u[0][c] + q[1] * s->u[1][c] + q[2] * s->u[2][c];
        bins[bin].add(gauss_terms(p, s->e, &logdet, &d2) ? d2 : std::numeric_limits<double>::infinity(), quantile, s->norad);
      }
      int n = 0;
      for (const Coverage& c : bins) n += coverage_json(c, gate)["status"] == "CALIBRATED";
      return n;
    };
    const double interval = number(opt, "discretizationSeconds", 600);
    nlohmann::json out = model.json;
    for (auto& r : out["regimes"]) {
      const int regime = r["regimeIndex"].get<int>();
      const auto found = by.find(regime);
      if (found == by.end() || !model.p0.count(regime)) continue;
      const std::vector<const Sample*>& list = found->second;
      auto nll = [&](const double x[3]) {
        double q[3], total = 0;
        for (int k = 0; k < 3; ++k) q[k] = x[k] <= -22 ? 0 : std::pow(10.0, x[k]);
        for (const Sample* s : list) {
          double p[6], logdet, d2;
          for (int c = 0; c < 6; ++c) p[c] = s->a[c] + q[0] * s->u[0][c] + q[1] * s->u[1][c] + q[2] * s->u[2][c];
          if (!gauss_terms(p, s->e, &logdet, &d2)) return std::numeric_limits<double>::infinity();
          total += logdet + d2;
        }
        return total;
      };
      double x[3] = {-22, -22, -22};
      const double start = nll(x);
      for (int sweep = 0; sweep < 6; ++sweep)
        for (int k = 0; k < 3; ++k) {
          double best = x[k], value = nll(x);
          for (double g = -22; g <= -2 + 1e-9; g += 0.5) {
            x[k] = g;
            const double v = nll(x);
            if (v < value) { value = v; best = g; }
          }
          double lo = std::max(-22.0, best - 0.5), hi = std::min(-2.0, best + 0.5);
          const double phi = (std::sqrt(5.0) - 1) / 2;
          for (int it = 0; it < 60; ++it) {
            const double m1 = hi - phi * (hi - lo), m2 = lo + phi * (hi - lo);
            x[k] = m1;
            const double v1 = nll(x);
            x[k] = m2;
            const double v2 = nll(x);
            (v1 < v2 ? hi : lo) = v1 < v2 ? m2 : m1;
          }
          x[k] = 0.5 * (lo + hi);
          if (!(nll(x) < value)) x[k] = best;
        }
      std::set<uint32_t> objects;
      for (const Sample* s : list) objects.insert(s->norad);
      double ml[3];
      for (int k = 0; k < 3; ++k) ml[k] = x[k] <= -22 + 1e-9 ? 0 : std::pow(10.0, x[k]);
      // Selection, on the fit week only: the maximum-likelihood densities
      // unless P0 alone passes the gate in more of its strata.
      const double zero[3] = {0, 0, 0};
      const int with_q = passing(all[regime], ml), without_q = passing(all[regime], zero);
      const bool p0_only = without_q > with_q;
      std::vector<double> q(3);
      for (int k = 0; k < 3; ++k) q[k] = p0_only ? 0 : ml[k];
      r["processNoise"] = {{"model", "WHITE_ACCELERATION"}, {"axes", "RADIAL_TRANSVERSE_NORMAL"}, {"spectralDensityM2S3", q},
                           {"discretizationSeconds", interval},
                           {"fit", {{"samples", list.size()}, {"objects", objects.size()}, {"window", window},
                                    {"negativeLogLikelihoodQ0", start}, {"negativeLogLikelihood", nll(x)},
                                    {"maximumLikelihoodM2S3", std::vector<double>(ml, ml + 3)},
                                    {"fitStrataCalibrated", {{"maximumLikelihood", with_q}, {"p0Alone", without_q}}},
                                    {"selected", p0_only ? "P0 alone" : "maximum likelihood"},
                                    {"rule", "maximum likelihood unless P0 alone passes the gate in more fit-window strata"}}}};
    }
    out["basis"] = std::string(model.json.value("basis", std::string())) +
                   "; Q: white-acceleration spectral densities per regime by maximum likelihood of HPOP's P(t) = "
                   "Phi P0 Phi' + Q against reference-state position errors at prediction ages above 0";
    return emit("model", out);
  }

  // test
  const double quantile[3] = {chi2_quantile3(kContainment[0]), chi2_quantile3(kContainment[1]), chi2_quantile3(kContainment[2])};
  const size_t bins = options.ages.size();
  std::vector<Coverage> with(options.regimes.size() * bins), without(options.regimes.size() * bins);
  // RMS error and RMS predicted sigma per RTN axis (with Q, and P0 alone), km.
  std::vector<std::array<double, 9>> rms(with.size(), std::array<double, 9>{});
  uint64_t no_bin = 0, no_covariance = 0, not_positive = 0;
  for (const Sample& s : samples) {
    const int bin = age_of(options, s.age);
    if (bin < 0) { ++no_bin; continue; }
    const size_t i = s.regime * bins + bin;
    if (!s.covariance || !model.p0.count(s.regime)) { ++with[i].missing; ++without[i].missing; ++no_covariance; continue; }
    const auto q = model.q.find(s.regime);
    double p[6], logdet, d2;
    for (int c = 0; c < 6; ++c)
      p[c] = s.a[c] + (q == model.q.end() ? 0 : q->second[0] * s.u[0][c] + q->second[1] * s.u[1][c] + q->second[2] * s.u[2][c]);
    // A covariance that is not positive definite cannot contain anything.
    if (gauss_terms(p, s.e, &logdet, &d2)) with[i].add(d2, quantile, s.norad);
    else { with[i].add(std::numeric_limits<double>::infinity(), quantile, s.norad); ++not_positive; }
    if (gauss_terms(s.a, s.e, &logdet, &d2)) without[i].add(d2, quantile, s.norad);
    else without[i].add(std::numeric_limits<double>::infinity(), quantile, s.norad);
    for (int k = 0; k < 3; ++k) {
      const double* u = s.axes[k];
      auto along = [&](const double m[6]) {
        const double full[3][3] = {{m[0], m[1], m[2]}, {m[1], m[3], m[4]}, {m[2], m[4], m[5]}};
        double v = 0;
        for (int a = 0; a < 3; ++a)
          for (int b = 0; b < 3; ++b) v += u[a] * full[a][b] * u[b];
        return v * 1e-6;  // m^2 -> km^2
      };
      rms[i][k] += s.rtn[k] * s.rtn[k];
      rms[i][3 + k] += along(p);
      rms[i][6 + k] += along(s.a);
    }
  }
  counts["outsideAgeBins"] = no_bin;
  counts["withoutCovariance"] = no_covariance;
  counts["notPositiveDefinite"] = not_positive;
  nlohmann::json strata = nlohmann::json::array();
  for (size_t i = 0; i < with.size(); ++i) {
    if (!with[i].n && !with[i].missing) continue;
    const size_t r = i / bins, a = i % bins;
    const auto q = model.q.find(static_cast<int>(r));
    const double n = static_cast<double>(std::max<uint64_t>(1, with[i].n));
    std::vector<double> error(3), sigma(3), sigma0(3);
    for (int k = 0; k < 3; ++k) {
      error[k] = std::sqrt(rms[i][k] / n);
      sigma[k] = std::sqrt(rms[i][3 + k] / n);
      sigma0[k] = std::sqrt(rms[i][6 + k] / n);
    }
    strata.push_back({{"regime", options.regimes[r].id}, {"regimeIndex", r}, {"ageIndex", a},
                      {"ageDays", {options.ages[a].first, options.ages[a].second}},
                      {"rmsErrorRtnKm", error}, {"rmsSigmaRtnKm", sigma}, {"rmsSigmaP0OnlyRtnKm", sigma0},
                      {"spectralDensityM2S3", q == model.q.end() ? std::vector<double>{0, 0, 0} : std::vector<double>(q->second.begin(), q->second.end())},
                      {"coverage", coverage_json(with[i], gate)}, {"coverageP0Only", coverage_json(without[i], gate)}});
  }
  return emit("report", {{"kind", "hpop-covariance-coverage"}, {"version", 1}, {"window", window}, {"gate", gate_json(gate)},
                         {"counts", counts}, {"strata", strata}});
}
