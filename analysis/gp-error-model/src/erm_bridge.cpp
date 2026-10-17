// The module's wire contract: every data, option and report port carries one SDS Orbit Error Model ($ERM) record, one
// arm set (typed contracts 1.0: FlatBuffers only). The arithmetic of the methods is unchanged; it reads and writes its
// working values through nlohmann::json inside the module, and this file is the boundary: erm_to_work turns a
// verified $ERM into those working values, work_to_erm turns a method's result into the $ERM it emits. Numbers pass
// through as the same doubles and integers, so results are bit-identical to the module's earlier JSON ports.
// Constant texts the earlier ports carried (unit notes, kind and version tags) are not on the wire; the decoder
// restores what the methods read. The node config (plugin.getConfig, one ModuleConfig) carries the recipes of
// attach_covariance and attribute_maneuvers.
//
// Built in one translation unit after the SDS headers and nlohmann::json, before gp_error_model.cpp.

namespace ermb {

using J = nlohmann::json;
using U = std::unique_ptr<ERMCountsT>;

// ── small helpers ──
double num(const J& j, const char* k, double def) { return j.is_object() && j.contains(k) && j[k].is_number() ? j[k].get<double>() : def; }
uint64_t unum(const J& j, const char* k, uint64_t def = 0) {
  if (!j.is_object() || !j.contains(k) || !j[k].is_number()) return def;
  const double v = j[k].get<double>();
  return v > 0 ? static_cast<uint64_t>(v) : 0;
}
std::string str(const J& j, const char* k) { return j.is_object() && j.contains(k) && j[k].is_string() ? j[k].get<std::string>() : std::string(); }
bool has(const J& j, const char* k) { return j.is_object() && j.contains(k) && !j[k].is_null(); }
// An array of numbers as doubles; null entries (NaN as the JSON text wrote them) become NaN.
std::vector<double> dvec(const J& j) {
  std::vector<double> out;
  if (!j.is_array()) return out;
  out.reserve(j.size());
  for (const auto& x : j) out.push_back(x.is_number() ? x.get<double>() : std::nan(""));
  return out;
}
std::vector<double> dvec(const J& j, const char* k) { return has(j, k) ? dvec(j[k]) : std::vector<double>(); }
// A row-major nested array (rows of numbers) flattened.
std::vector<double> flat(const J& j) {
  std::vector<double> out;
  if (!j.is_array()) return out;
  for (const auto& row : j)
    for (double x : dvec(row)) out.push_back(x);
  return out;
}
std::vector<std::string> svec(const J& j) {
  std::vector<std::string> out;
  if (!j.is_array()) return out;
  for (const auto& x : j) out.push_back(x.is_string() ? x.get<std::string>() : x.dump());
  return out;
}
J darr(const std::vector<double>& v) { return J(v); }
J sarr(const std::vector<std::string>& v) { return J(v); }
// An id as given: a string as is, anything else as its JSON text.
std::string id_text(const J& j, const char* k) {
  if (!has(j, k)) return {};
  return j[k].is_string() ? j[k].get<std::string>() : j[k].dump();
}
J nan_null(double x) { return std::isnan(x) ? J(nullptr) : J(x); }
// A number that arrived as an integer (counts, indices) stays one, as the methods test is_number_unsigned.
J whole(double v) {
  if (std::isfinite(v) && v == std::floor(v) && std::fabs(v) < 9.2e18) return v >= 0 ? J(static_cast<uint64_t>(v)) : J(static_cast<int64_t>(v));
  return J(v);
}

// ── counts ──
struct CountField {
  const char* key;
  uint32_t ERMCountsT::*field;
};
const CountField kCounts[] = {
    {"elementSets", &ERMCountsT::ELEMENT_SETS}, {"refused", &ERMCountsT::REFUSED}, {"duplicateEpochs", &ERMCountsT::DUPLICATE_EPOCHS},
    {"unclassified", &ERMCountsT::UNCLASSIFIED}, {"objects", &ERMCountsT::OBJECTS}, {"samples", &ERMCountsT::SAMPLES},
    {"propagationFailures", &ERMCountsT::PROPAGATION_FAILURES}, {"referenceEpochs", &ERMCountsT::REFERENCE_EPOCHS},
    {"referenceObjectsWithoutElements", &ERMCountsT::REFERENCE_OBJECTS_WITHOUT_ELEMENTS}, {"arcs", &ERMCountsT::ARCS},
    {"targets", &ERMCountsT::TARGETS}, {"setsWithoutReference", &ERMCountsT::SETS_WITHOUT_REFERENCE},
    {"setsWithoutTargets", &ERMCountsT::SETS_WITHOUT_TARGETS}, {"arcsWithoutModelRegime", &ERMCountsT::ARCS_WITHOUT_MODEL_REGIME},
    {"targetsOutsideWindow", &ERMCountsT::TARGETS_OUTSIDE_WINDOW}, {"targetsWithoutPrediction", &ERMCountsT::TARGETS_WITHOUT_PREDICTION},
    {"outsideAgeBins", &ERMCountsT::OUTSIDE_AGE_BINS}, {"withoutCovariance", &ERMCountsT::WITHOUT_COVARIANCE},
    {"notPositiveDefinite", &ERMCountsT::NOT_POSITIVE_DEFINITE}, {"missingTargets", &ERMCountsT::MISSING_TARGETS},
    {"missingSets", &ERMCountsT::MISSING_SETS}, {"differences", &ERMCountsT::DIFFERENCES}, {"mapped", &ERMCountsT::MAPPED},
    {"failed", &ERMCountsT::FAILED}, {"pairs", &ERMCountsT::PAIRS}, {"withoutTruthCovariance", &ERMCountsT::WITHOUT_TRUTH_COVARIANCE},
    {"outsideRegimes", &ERMCountsT::OUTSIDE_REGIMES}, {"states", &ERMCountsT::STATES}, {"streams", &ERMCountsT::STREAMS},
    {"blocks", &ERMCountsT::BLOCKS}, {"covariances", &ERMCountsT::COVARIANCES}, {"aprioriSets", &ERMCountsT::APRIORI_SETS},
    {"fitted", &ERMCountsT::FITTED}, {"calibratedRows", &ERMCountsT::CALIBRATED_ROWS}, {"uncalibratedRows", &ERMCountsT::UNCALIBRATED_ROWS},
    {"statesOfOlderSets", &ERMCountsT::STATES_OF_OLDER_SETS}, {"maneuvers", &ERMCountsT::MANEUVERS},
};
const char* kBaseCounts[] = {"elementSets", "refused", "duplicateEpochs", "unclassified", "objects", "samples",
                             "propagationFailures", "referenceEpochs", "referenceObjectsWithoutElements"};

U counts_in(const J& j) {
  auto c = std::make_unique<ERMCountsT>();
  if (!j.is_object()) return c;
  for (const CountField& f : kCounts) c.get()->*f.field = static_cast<uint32_t>(unum(j, f.key));
  if (has(j, "frames") && j["frames"].is_object())
    for (const auto& kv : j["frames"].items()) {
      auto n = std::make_unique<ERMNamedCountT>();
      n->NAME = kv.key();
      n->COUNT = static_cast<uint32_t>(kv.value().is_number() ? kv.value().get<double>() : 0);
      c->FRAME_COUNTS.push_back(std::move(n));
    }
  if (has(j, "rule1") || has(j, "rule2") || has(j, "rule3") || has(j, "rule4"))
    for (const char* k : {"rule1", "rule2", "rule3", "rule4"}) c->RULE_COUNTS.push_back(static_cast<uint32_t>(unum(j, k)));
  return c;
}
// The counts the methods read back: the base counters always (a prior's, a model's), every other one when set.
J counts_out(const ERMCountsT* c) {
  J j = J::object();
  ERMCountsT zero;
  if (!c) c = &zero;
  for (const char* k : kBaseCounts)
    for (const CountField& f : kCounts)
      if (std::strcmp(f.key, k) == 0) j[k] = c->*f.field;
  for (const CountField& f : kCounts)
    if (c->*f.field && !j.contains(f.key)) j[f.key] = c->*f.field;
  return j;
}

// ── strata settings ──
std::unique_ptr<ERMStrataSettingsT> strata_in(const J& j, bool step_and_clip) {
  auto s = std::make_unique<ERMStrataSettingsT>();
  if (has(j, "regimes") && j["regimes"].is_array())
    for (const auto& r : j["regimes"]) {
      auto x = std::make_unique<ERMRegimeT>();
      x->ID = str(r, "id");
      const auto alt = dvec(r, "altitudeKm"), ecc = dvec(r, "eccentricity");
      if (alt.size() == 2) { x->ALTITUDE_MIN_KM = alt[0]; x->ALTITUDE_MAX_KM = alt[1]; }
      if (ecc.size() == 2) { x->ECCENTRICITY_MIN = ecc[0]; x->ECCENTRICITY_MAX = ecc[1]; }
      s->REGIMES.push_back(std::move(x));
    }
  if (has(j, "ageBinsDays") && j["ageBinsDays"].is_array())
    for (const auto& a : j["ageBinsDays"]) {
      auto x = std::make_unique<ERMAgeBinT>();
      const auto v = dvec(a);
      if (v.size() == 2) { x->MIN_DAYS = v[0]; x->MAX_DAYS = v[1]; }
      s->AGE_BINS.push_back(std::move(x));
    }
  if (step_and_clip) {
    s->REFERENCE_STEP_S = num(j, "referenceStepSeconds", 300);
    if (has(j, "clip")) {
      const J& c = j["clip"];
      s->CLIP = std::make_unique<ERMClipSettingsT>();
      s->CLIP->K = num(c, "k", 0);
      if (has(c, "strata"))
        for (const auto& x : c["strata"]) {
          auto e = std::make_unique<ERMClipCentreT>();
          e->REGIME_INDEX = static_cast<uint32_t>(unum(x, "regime"));
          e->AGE_INDEX = static_cast<uint32_t>(unum(x, "age"));
          e->CENTRE_KM = dvec(x, "centre");
          e->SCALE_KM = dvec(x, "scale");
          s->CLIP->STRATA.push_back(std::move(e));
        }
    }
  }
  return s;
}
// Into `j`: regimes and age bins when the record names them (else the defaults apply), and with step_and_clip the
// reference step and the clip.
void strata_out(const ERMStrataSettingsT* s, J& j, bool step_and_clip) {
  if (!s) return;
  if (!s->REGIMES.empty()) {
    j["regimes"] = J::array();
    for (const auto& r : s->REGIMES)
      j["regimes"].push_back({{"id", r->ID}, {"altitudeKm", {r->ALTITUDE_MIN_KM, r->ALTITUDE_MAX_KM}},
                              {"eccentricity", {r->ECCENTRICITY_MIN, r->ECCENTRICITY_MAX}}});
  }
  if (!s->AGE_BINS.empty()) {
    j["ageBinsDays"] = J::array();
    for (const auto& a : s->AGE_BINS) j["ageBinsDays"].push_back({a->MIN_DAYS, a->MAX_DAYS});
  }
  if (!step_and_clip) return;
  j["referenceStepSeconds"] = s->REFERENCE_STEP_S;
  if (s->CLIP) {
    J c{{"k", s->CLIP->K}, {"strata", J::array()}};
    for (const auto& x : s->CLIP->STRATA)
      c["strata"].push_back({{"regime", x->REGIME_INDEX}, {"age", x->AGE_INDEX}, {"centre", x->CENTRE_KM}, {"scale", x->SCALE_KM}});
    j["clip"] = c;
  }
}

// ── gate and coverage ──
std::unique_ptr<ERMGateT> gate_in(const J& g) {
  auto x = std::make_unique<ERMGateT>();
  x->TOLERANCE = num(g, "tolerance", 0.05);
  x->TAIL_LIMIT = num(g, "tailLimit", 0.01);
  x->MINIMUM_SAMPLES = static_cast<uint32_t>(num(g, "minimumSamples", 30));
  x->MINIMUM_OBJECTS = static_cast<uint32_t>(num(g, "minimumObjects", 3));
  x->RULE = str(g, "rule");
  x->NOMINAL = dvec(g, "nominal");
  return x;
}
J gate_out(const ERMGateT& g) {
  J j{{"tolerance", g.TOLERANCE}, {"tailLimit", g.TAIL_LIMIT}, {"minimumSamples", g.MINIMUM_SAMPLES}, {"minimumObjects", g.MINIMUM_OBJECTS}};
  if (!g.RULE.empty()) j["rule"] = g.RULE;
  if (!g.NOMINAL.empty()) j["nominal"] = g.NOMINAL;
  return j;
}
ermCoverageVerdict verdict_in(const std::string& s) {
  if (s == "CALIBRATED") return ermCoverageVerdict::Calibrated;
  if (s == "FAILED") return ermCoverageVerdict::Failed;
  if (s == "INSUFFICIENT") return ermCoverageVerdict::Insufficient;
  if (s == "NO_MODEL") return ermCoverageVerdict::NoModel;
  return ermCoverageVerdict::Unspecified;
}
const char* verdict_out(ermCoverageVerdict v) {
  switch (v) {
    case ermCoverageVerdict::Calibrated: return "CALIBRATED";
    case ermCoverageVerdict::Failed: return "FAILED";
    case ermCoverageVerdict::Insufficient: return "INSUFFICIENT";
    case ermCoverageVerdict::NoModel: return "NO_MODEL";
    default: return "";
  }
}
std::unique_ptr<ERMCoverageT> coverage_in(const J& g) {
  auto c = std::make_unique<ERMCoverageT>();
  c->N = unum(g, "n");
  c->OBJECTS = static_cast<uint32_t>(unum(g, "objects"));
  c->VERDICT = verdict_in(str(g, "status"));
  c->MEAN_D2 = num(g, "meanD2", std::nan(""));
  c->INSIDE = dvec(g, "inside");
  c->PIT = dvec(g, "pit");
  c->PIT_MAX_CDF_GAP = num(g, "pitMaxCdfGap", std::nan(""));
  c->MISSING_MODEL = unum(g, "missingModel");
  return c;
}
J coverage_out(const ERMCoverageT& c, bool missing_model) {
  J g{{"n", c.N}, {"objects", c.OBJECTS}, {"status", verdict_out(c.VERDICT)}};
  if (!std::isnan(c.MEAN_D2)) g["meanD2"] = c.MEAN_D2;
  if (!c.INSIDE.empty()) g["inside"] = c.INSIDE;
  if (!c.PIT.empty()) g["pit"] = c.PIT;
  if (!std::isnan(c.PIT_MAX_CDF_GAP)) g["pitMaxCdfGap"] = c.PIT_MAX_CDF_GAP;
  if (missing_model) g["missingModel"] = c.MISSING_MODEL;
  return g;
}

// ── basis, forms ──
ermErrorBasis basis_in(const std::string& mode) {
  return mode == "reference" ? ermErrorBasis::ReferenceStates : mode == "gp-differences" ? ermErrorBasis::SetDifferences : ermErrorBasis::Unspecified;
}
std::string basis_out(ermErrorBasis b) {
  return b == ermErrorBasis::ReferenceStates ? "reference" : b == ermErrorBasis::SetDifferences ? "gp-differences" : "";
}
covarianceCalibration calibration_in(const std::string& s) {
  return s == "CALIBRATED" ? covarianceCalibration::Calibrated : s == "UNCALIBRATED" ? covarianceCalibration::Uncalibrated : covarianceCalibration::Unspecified;
}
const char* calibration_out(covarianceCalibration c) {
  return c == covarianceCalibration::Calibrated ? "CALIBRATED" : c == covarianceCalibration::Uncalibrated ? "UNCALIBRATED" : "";
}
std::unique_ptr<ERMProcessNoiseT> noise_in(const J& n) {
  auto x = std::make_unique<ERMProcessNoiseT>();
  x->MODEL = str(n, "model");
  x->AXES = str(n, "axes");
  x->SPECTRAL_DENSITY_M2_S3 = dvec(n, "spectralDensityM2S3");
  x->DISCRETIZATION_S = num(n, "discretizationSeconds", 0);
  return x;
}
J noise_out(const ERMProcessNoiseT& n) {
  J j{{"spectralDensityM2S3", n.SPECTRAL_DENSITY_M2_S3}, {"discretizationSeconds", n.DISCRETIZATION_S}};
  if (!n.MODEL.empty()) j["model"] = n.MODEL;
  if (!n.AXES.empty()) j["axes"] = n.AXES;
  return j;
}
std::pair<std::string, std::string> window_in(const J& w) {
  if (w.is_array() && w.size() == 2 && w[0].is_string() && w[1].is_string()) return {w[0].get<std::string>(), w[1].get<std::string>()};
  return {};
}

// The units notes the earlier JSON models carried (constant text).
J stratified_units() {
  return {{"position", "km"}, {"velocity", "km/s"}, {"components", {"R", "T", "N", "dR", "dT", "dN"}},
          {"covariance", "lower triangle, row-major: RR, TR, TT, NR, NT, NN, dR R, ..."}};
}
J ffm_units() {
  return {{"p0", "km, km/s; lower triangle, row-major, RTN: RR, TR, TT, NR, NT, NN, dR R, ..."},
          {"spectralDensityM2S3", "m^2/s^3 per R, T, N axis"}};
}

// ── models ──
std::unique_ptr<ERMModelT> model_in(const J& j) {
  auto m = std::make_unique<ERMModelT>();
  const std::string kind = str(j, "kind");
  m->ID = str(j, "id");
  m->CANDIDATE = str(j, "candidate");
  m->BASIS_TEXT = str(j, "basis");
  m->LABEL = str(j, "label");
  if (has(j, "counts")) m->COUNTS = counts_in(j["counts"]);
  if (kind == "gp-error-model") {
    m->FORM = ermModelForm::StratifiedStatistics;
    m->BASIS = basis_in(str(j, "mode"));
    m->PROPAGATOR = str(j, "propagator");
    m->STRATA_SETTINGS = strata_in(j, false);
    m->QUANTILE_PROBABILITIES = dvec(j, "quantileProbabilities");
    m->COVERAGE_MODEL = str(j, "coverageModel");
    if (has(j, "gate")) m->GATE = gate_in(j["gate"]);
    if (has(j, "strata"))
      for (const auto& s : j["strata"]) {
        auto x = std::make_unique<ERMModelStratumT>();
        x->REGIME = str(s, "regime");
        x->REGIME_INDEX = static_cast<uint32_t>(unum(s, "regimeIndex"));
        x->AGE_INDEX = static_cast<uint32_t>(unum(s, "ageIndex"));
        const auto age = dvec(s, "ageDays");
        if (age.size() == 2) { x->AGE_MIN_DAYS = age[0]; x->AGE_MAX_DAYS = age[1]; }
        x->N = unum(s, "n");
        x->MEAN = dvec(s, "mean");
        x->COVARIANCE = dvec(s, "covariance");
        if (has(s, "quantiles")) x->QUANTILES = flat(s["quantiles"]);
        x->MEDIAN = dvec(s, "median");
        x->ROBUST_SIGMA = dvec(s, "robustSigma");
        if (has(s, "clipped")) {
          const J& c = s["clipped"];
          x->CLIPPED = std::make_unique<ERMClippedStatisticsT>();
          x->CLIPPED->K = num(c, "k", 0);
          x->CLIPPED->N = unum(c, "n");
          x->CLIPPED->FRACTION_REMOVED = num(c, "fractionRemoved", 0);
          x->CLIPPED->MEAN = dvec(c, "mean");
          x->CLIPPED->COVARIANCE = dvec(c, "covariance");
        }
        if (has(s, "coverage")) x->COVERAGE = coverage_in(s["coverage"]);
        if (has(s, "scale")) {
          x->SCALE = std::make_unique<ERMStratumScaleT>();
          x->SCALE->FACTORS = dvec(s["scale"], "factors");
          x->SCALE->TRUTH_N = unum(s["scale"], "truthN");
        }
        m->STRATA.push_back(std::move(x));
      }
    if (has(j, "scale")) {
      const J& s = j["scale"];
      m->SCALE = std::make_unique<ERMModelScaleT>();
      m->SCALE->BASIS = str(s, "basis");
      if (has(s, "truthCounts")) m->SCALE->TRUTH_COUNTS = counts_in(s["truthCounts"]);
      m->SCALE->TRUTH_WINDOW = str(s, "truthWindow");
      m->SCALE->MINIMUM_SAMPLES = static_cast<uint32_t>(num(s, "minimumSamples", 0));
    }
  } else if (kind == "ffm-covariance-model") {
    m->FORM = ermModelForm::PropagatorCovariance;
    const auto w = window_in(has(j, "epochWindow") ? j["epochWindow"] : J());
    m->EPOCH_WINDOW_START = w.first;
    m->EPOCH_WINDOW_STOP = w.second;
    if (has(j, "regimes"))
      for (const auto& r : j["regimes"]) {
        auto x = std::make_unique<ERMPropagatorRegimeT>();
        x->REGIME_INDEX = static_cast<uint32_t>(unum(r, "regimeIndex"));
        x->REGIME = str(r, "regime");
        x->N = unum(r, "n");
        x->KEPT = unum(r, "kept");
        x->OBJECTS = static_cast<uint32_t>(unum(r, "objects"));
        x->CLIP_K = num(r, "clipK", 0);
        x->P0 = dvec(r, "p0");
        if (has(r, "processNoise")) {
          const J& n = r["processNoise"];
          x->PROCESS_NOISE = noise_in(n);
          if (has(n, "fit")) {
            const J& f = n["fit"];
            x->FIT = std::make_unique<ERMNoiseFitT>();
            x->FIT->SAMPLES = unum(f, "samples");
            x->FIT->OBJECTS = static_cast<uint32_t>(unum(f, "objects"));
            const auto fw = window_in(has(f, "window") ? f["window"] : J());
            x->FIT->WINDOW_START = fw.first;
            x->FIT->WINDOW_STOP = fw.second;
            x->FIT->NEGATIVE_LOG_LIKELIHOOD_Q0 = num(f, "negativeLogLikelihoodQ0", 0);
            x->FIT->NEGATIVE_LOG_LIKELIHOOD = num(f, "negativeLogLikelihood", 0);
            x->FIT->MAXIMUM_LIKELIHOOD_M2_S3 = dvec(f, "maximumLikelihoodM2S3");
            if (has(f, "fitStrataCalibrated")) {
              x->FIT->CALIBRATED_STRATA_MAXIMUM_LIKELIHOOD = static_cast<uint32_t>(unum(f["fitStrataCalibrated"], "maximumLikelihood"));
              x->FIT->CALIBRATED_STRATA_P0_ALONE = static_cast<uint32_t>(unum(f["fitStrataCalibrated"], "p0Alone"));
            }
            x->FIT->SELECTED = str(f, "selected");
            x->FIT->RULE = str(f, "rule");
          }
        }
        m->PROPAGATOR_REGIMES.push_back(std::move(x));
      }
  } else if (kind == "e14-factors") {
    m->FORM = ermModelForm::HorizonFactors;
    m->CALIBRATION_VERSION = str(j, "calibrationVersion").empty() ? str(j, "version") : str(j, "calibrationVersion");
    m->STRATA_SETTINGS = strata_in(j, false);
    if (has(j, "strata"))
      for (const auto& s : j["strata"]) {
        auto x = std::make_unique<ERMHorizonFactorT>();
        x->REGIME = str(s, "regime") == "*" ? std::string() : str(s, "regime");
        const auto h = dvec(s, "horizonDays");
        if (h.size() == 2) { x->HORIZON_MIN_DAYS = h[0]; x->HORIZON_MAX_DAYS = h[1]; }
        x->AXES_FACTORS = dvec(s, "axesFactors");
        x->FACTOR = x->AXES_FACTORS.empty() ? num(s, "factor", std::nan("")) : std::nan("");
        x->STATUS = str(s, "status");
        m->HORIZON_FACTORS.push_back(std::move(x));
      }
  } else {  // e14-element-set-model, and E14's frozen e14-s3-kc in the same form
    m->FORM = ermModelForm::ElementSetModel;
    m->CALIBRATION_VERSION = str(j, "calibrationVersion").empty() ? str(j, "version") : str(j, "calibrationVersion");
    m->STRATA_SETTINGS = strata_in(j, false);
    m->HORIZONS_DAYS = dvec(j, "horizonsDays");
    m->MINIMUM_BIN_SAMPLES = unum(j, "minimumBinSamples");
    if (has(j, "strata"))
      for (const auto& s : j["strata"]) {
        auto x = std::make_unique<ERMModelStratumT>();
        x->REGIME = str(s, "regime");
        x->REGIME_INDEX = static_cast<uint32_t>(unum(s, "regimeIndex"));
        x->AGE_INDEX = static_cast<uint32_t>(unum(s, "ageIndex"));
        x->N = unum(s, "n");
        x->COVARIANCE = dvec(s, "covariance");
        m->STRATA.push_back(std::move(x));
      }
    std::map<std::pair<uint32_t, uint32_t>, ERMStratumFactorT*> cells;
    auto cell = [&](const J& s) {
      const auto key = std::make_pair(static_cast<uint32_t>(unum(s, "regimeIndex")), static_cast<uint32_t>(unum(s, "ageIndex")));
      auto it = cells.find(key);
      if (it != cells.end()) return it->second;
      auto x = std::make_unique<ERMStratumFactorT>();
      x->REGIME_INDEX = key.first;
      x->AGE_INDEX = key.second;
      ERMStratumFactorT* p = x.get();
      m->STRATUM_FACTORS.push_back(std::move(x));
      return cells[key] = p;
    };
    if (has(j, "factors"))
      for (const auto& f : j["factors"]) cell(f)->FACTOR = num(f, "factor", std::nan(""));
    if (has(j, "status"))
      for (const auto& s : j["status"]) cell(s)->STATUS = str(s, "status");
    if (has(j, "cells"))
      for (const auto& c : j["cells"]) {
        auto x = std::make_unique<ERMRealismCellT>();
        x->REGIME_INDEX = static_cast<uint32_t>(unum(c, "regimeIndex"));
        x->AGE_INDEX = static_cast<uint32_t>(unum(c, "ageIndex"));
        x->DECISION = str(c, "decision");
        x->REALISM = std::make_unique<CVRT>();
        x->REALISM->REGIME = str(c, "regime");
        x->REALISM->HORIZON_DAYS = num(c, "horizonDays", std::nan(""));
        x->REALISM->MEAN_D2_OVER_3 = num(c, "meanD2Over3", std::nan(""));
        x->REALISM->COVERAGE_95 = num(c, "coverage95", std::nan(""));
        x->REALISM->SAMPLES = static_cast<uint32_t>(unum(c, "samples"));
        x->REALISM->OBJECTS = static_cast<uint32_t>(unum(c, "objects"));
        x->REALISM->CALIBRATION = calibration_in(str(c, "calibration"));
        m->CELLS.push_back(std::move(x));
      }
    if (has(j, "measuredOn")) {
      const J& o = j["measuredOn"];
      m->MEASURED_ON = std::make_unique<ERMMeasuredOnT>();
      m->MEASURED_ON->LINEAGES = has(o, "lineages") ? svec(o["lineages"]) : std::vector<std::string>();
      m->MEASURED_ON->WINDOW = str(o, "window");
      m->MEASURED_ON->RULE = str(o, "rule");
      m->MEASURED_ON->EVIDENCE = str(o, "evidence");
    }
    if (has(j, "sources")) m->SOURCES = svec(j["sources"]);
    m->POOLED = has(j, "pooled") && j["pooled"].is_boolean() && j["pooled"].get<bool>();
    if (has(j, "provenance")) {
      const J& p = j["provenance"];
      m->PROVENANCE_REPOSITORY = str(p, "repository");
      m->PROVENANCE_COMMIT = str(p, "commit");
      if (has(p, "files") && p["files"].is_object())
        for (const auto& kv : p["files"].items()) {
          auto f = std::make_unique<ERMProvenanceFileT>();
          f->NAME = kv.key();
          f->SHA256 = kv.value().is_string() ? kv.value().get<std::string>() : std::string();
          m->PROVENANCE_FILES.push_back(std::move(f));
        }
    }
  }
  return m;
}

J model_out(const ERMModelT& m) {
  J j = J::object();
  if (!m.ID.empty()) j["id"] = m.ID;
  if (!m.CANDIDATE.empty()) j["candidate"] = m.CANDIDATE;
  if (!m.LABEL.empty()) j["label"] = m.LABEL;
  switch (m.FORM) {
    case ermModelForm::StratifiedStatistics: {
      strata_out(m.STRATA_SETTINGS.get(), j, false);
      j["kind"] = "gp-error-model";
      j["version"] = 1;
      j["mode"] = basis_out(m.BASIS);
      j["basis"] = m.BASIS_TEXT;
      j["propagator"] = m.PROPAGATOR;
      j["units"] = stratified_units();
      j["counts"] = counts_out(m.COUNTS.get());
      j["quantileProbabilities"] = m.QUANTILE_PROBABILITIES;
      if (!m.COVERAGE_MODEL.empty()) j["coverageModel"] = m.COVERAGE_MODEL;
      if (m.GATE) j["gate"] = gate_out(*m.GATE);
      j["strata"] = J::array();
      for (const auto& s : m.STRATA) {
        J x{{"regime", s->REGIME}, {"regimeIndex", s->REGIME_INDEX}, {"ageIndex", s->AGE_INDEX},
            {"ageDays", {s->AGE_MIN_DAYS, s->AGE_MAX_DAYS}}, {"n", s->N}, {"mean", s->MEAN}};
        if (!s->COVARIANCE.empty()) x["covariance"] = s->COVARIANCE;
        if (!s->QUANTILES.empty()) {
          J q = J::array();
          const size_t width = s->QUANTILES.size() / 6;
          for (size_t c = 0; c < 6; ++c)
            q.push_back(std::vector<double>(s->QUANTILES.begin() + c * width, s->QUANTILES.begin() + (c + 1) * width));
          x["quantiles"] = q;
        }
        if (!s->MEDIAN.empty()) x["median"] = s->MEDIAN;
        if (!s->ROBUST_SIGMA.empty()) x["robustSigma"] = s->ROBUST_SIGMA;
        if (s->CLIPPED) {
          J c{{"k", s->CLIPPED->K}, {"n", s->CLIPPED->N}, {"fractionRemoved", s->CLIPPED->FRACTION_REMOVED}};
          if (!s->CLIPPED->MEAN.empty()) c["mean"] = s->CLIPPED->MEAN;
          if (!s->CLIPPED->COVARIANCE.empty()) c["covariance"] = s->CLIPPED->COVARIANCE;
          x["clipped"] = c;
        }
        if (s->COVERAGE) x["coverage"] = coverage_out(*s->COVERAGE, true);
        if (s->SCALE) x["scale"] = {{"factors", s->SCALE->FACTORS}, {"truthN", s->SCALE->TRUTH_N}};
        j["strata"].push_back(x);
      }
      if (m.SCALE) {
        j["scale"] = {{"basis", m.SCALE->BASIS},
                      {"truthCounts", m.SCALE->TRUTH_COUNTS ? counts_out(m.SCALE->TRUTH_COUNTS.get()) : J(nullptr)},
                      {"truthWindow", m.SCALE->TRUTH_WINDOW.empty() ? J(nullptr) : J(m.SCALE->TRUTH_WINDOW)},
                      {"minimumSamples", m.SCALE->MINIMUM_SAMPLES}};
      }
      break;
    }
    case ermModelForm::PropagatorCovariance: {
      j["kind"] = "ffm-covariance-model";
      j["version"] = 1;
      j["basis"] = m.BASIS_TEXT;
      j["units"] = ffm_units();
      if (!m.EPOCH_WINDOW_START.empty() || !m.EPOCH_WINDOW_STOP.empty()) j["epochWindow"] = {m.EPOCH_WINDOW_START, m.EPOCH_WINDOW_STOP};
      if (m.COUNTS) {
        J c = J::object();
        for (const char* k : {"samples", "targetsOutsideWindow", "targetsWithoutPrediction"})
          for (const CountField& f : kCounts)
            if (std::strcmp(f.key, k) == 0) c[k] = m.COUNTS.get()->*f.field;
        j["counts"] = c;
      }
      j["regimes"] = J::array();
      for (const auto& r : m.PROPAGATOR_REGIMES) {
        J x{{"regimeIndex", r->REGIME_INDEX}, {"regime", r->REGIME}};
        if (r->N) x["n"] = r->N;
        if (r->KEPT) x["kept"] = r->KEPT;
        if (r->OBJECTS) x["objects"] = r->OBJECTS;
        if (r->CLIP_K != 0) x["clipK"] = r->CLIP_K;
        if (!r->P0.empty()) x["p0"] = r->P0;
        if (r->PROCESS_NOISE) {
          J n = noise_out(*r->PROCESS_NOISE);
          if (r->FIT) {
            const ERMNoiseFitT& f = *r->FIT;
            n["fit"] = {{"samples", f.SAMPLES}, {"objects", f.OBJECTS}, {"window", {f.WINDOW_START, f.WINDOW_STOP}},
                        {"negativeLogLikelihoodQ0", f.NEGATIVE_LOG_LIKELIHOOD_Q0}, {"negativeLogLikelihood", f.NEGATIVE_LOG_LIKELIHOOD},
                        {"maximumLikelihoodM2S3", f.MAXIMUM_LIKELIHOOD_M2_S3},
                        {"fitStrataCalibrated", {{"maximumLikelihood", f.CALIBRATED_STRATA_MAXIMUM_LIKELIHOOD}, {"p0Alone", f.CALIBRATED_STRATA_P0_ALONE}}},
                        {"selected", f.SELECTED}, {"rule", f.RULE}};
          }
          x["processNoise"] = n;
        }
        j["regimes"].push_back(x);
      }
      break;
    }
    case ermModelForm::HorizonFactors: {
      j["kind"] = "e14-factors";
      j["version"] = m.CALIBRATION_VERSION;
      strata_out(m.STRATA_SETTINGS.get(), j, false);
      j["strata"] = J::array();
      for (const auto& f : m.HORIZON_FACTORS) {
        J x{{"horizonDays", {f->HORIZON_MIN_DAYS, f->HORIZON_MAX_DAYS}}};
        if (!f->REGIME.empty()) x["regime"] = f->REGIME;
        if (!f->AXES_FACTORS.empty()) x["axesFactors"] = f->AXES_FACTORS;
        else if (!std::isnan(f->FACTOR)) x["factor"] = f->FACTOR;
        if (!f->STATUS.empty()) x["status"] = f->STATUS;
        j["strata"].push_back(x);
      }
      break;
    }
    default: {  // ElementSetModel
      j["kind"] = "e14-element-set-model";
      j["version"] = m.CALIBRATION_VERSION;
      if (!m.CALIBRATION_VERSION.empty()) j["calibrationVersion"] = m.CALIBRATION_VERSION;
      if (!m.BASIS_TEXT.empty()) j["basis"] = m.BASIS_TEXT;
      strata_out(m.STRATA_SETTINGS.get(), j, false);
      if (!m.HORIZONS_DAYS.empty()) j["horizonsDays"] = m.HORIZONS_DAYS;
      if (m.MINIMUM_BIN_SAMPLES) j["minimumBinSamples"] = m.MINIMUM_BIN_SAMPLES;
      j["strata"] = J::array();
      for (const auto& s : m.STRATA) {
        J x{{"regimeIndex", s->REGIME_INDEX}, {"ageIndex", s->AGE_INDEX}, {"covariance", s->COVARIANCE}};
        if (!s->REGIME.empty()) x["regime"] = s->REGIME;
        if (s->N) x["n"] = s->N;  // a stratum without its sample count is always usable
        j["strata"].push_back(x);
      }
      J factors = J::array(), status = J::array();
      for (const auto& f : m.STRATUM_FACTORS) {
        if (!std::isnan(f->FACTOR)) factors.push_back({{"regimeIndex", f->REGIME_INDEX}, {"ageIndex", f->AGE_INDEX}, {"factor", f->FACTOR}});
        if (!f->STATUS.empty()) status.push_back({{"regimeIndex", f->REGIME_INDEX}, {"ageIndex", f->AGE_INDEX}, {"status", f->STATUS}});
      }
      if (!factors.empty()) j["factors"] = factors;
      if (!status.empty()) j["status"] = status;
      if (!m.CELLS.empty()) {
        j["cells"] = J::array();
        for (const auto& c : m.CELLS) {
          J x{{"regimeIndex", c->REGIME_INDEX}, {"ageIndex", c->AGE_INDEX}, {"decision", c->DECISION}};
          if (c->REALISM) {
            const CVRT& v = *c->REALISM;
            if (!v.REGIME.empty()) x["regime"] = v.REGIME;
            if (!std::isnan(v.HORIZON_DAYS)) x["horizonDays"] = v.HORIZON_DAYS;
            if (!std::isnan(v.MEAN_D2_OVER_3)) x["meanD2Over3"] = v.MEAN_D2_OVER_3;
            if (!std::isnan(v.COVERAGE_95)) x["coverage95"] = v.COVERAGE_95;
            x["samples"] = v.SAMPLES;
            x["objects"] = v.OBJECTS;
            if (v.CALIBRATION != covarianceCalibration::Unspecified) x["calibration"] = calibration_out(v.CALIBRATION);
          }
          j["cells"].push_back(x);
        }
      }
      if (m.MEASURED_ON)
        j["measuredOn"] = {{"lineages", m.MEASURED_ON->LINEAGES}, {"window", m.MEASURED_ON->WINDOW}, {"rule", m.MEASURED_ON->RULE},
                           {"evidence", m.MEASURED_ON->EVIDENCE}};
      if (!m.SOURCES.empty()) j["sources"] = m.SOURCES;
      if (m.POOLED) j["pooled"] = true;
      if (!m.PROVENANCE_REPOSITORY.empty() || !m.PROVENANCE_COMMIT.empty() || !m.PROVENANCE_FILES.empty()) {
        J files = J::object();
        for (const auto& f : m.PROVENANCE_FILES) files[f->NAME] = f->SHA256;
        j["provenance"] = {{"repository", m.PROVENANCE_REPOSITORY}, {"commit", m.PROVENANCE_COMMIT}, {"files", files}};
      }
      break;
    }
  }
  return j;
}

// ── accumulator ──
std::unique_ptr<ERMMomentsT> moments_in(const J& j) {
  auto m = std::make_unique<ERMMomentsT>();
  m->N = unum(j, "n");
  m->SUM = dvec(j, "sum");
  m->SQUARES = dvec(j, "sq");
  return m;
}
std::unique_ptr<ERMAccumulatorT> accumulator_in(const J& j) {
  auto a = std::make_unique<ERMAccumulatorT>();
  a->STRATA_SETTINGS = strata_in(j, false);
  a->BASIS = basis_in(str(j, "mode"));
  a->CLIP_K = num(j, "clipK", 0);
  a->COUNTS = counts_in(has(j, "counts") ? j["counts"] : J());
  a->COVERAGE_MODEL = str(j, "coverageModel");
  if (has(j, "strata"))
    for (const auto& x : j["strata"]) {
      auto s = std::make_unique<ERMAccumulatorStratumT>();
      s->REGIME_INDEX = static_cast<uint32_t>(unum(x, "regime"));
      s->AGE_INDEX = static_cast<uint32_t>(unum(x, "age"));
      s->MOMENTS = moments_in(x);
      if (has(x, "hist"))
        for (const auto& h : x["hist"]) {
          auto hist = std::make_unique<ERMHistogramT>();
          if (h.is_object())
            for (const auto& b : h.items())
              hist->BINS.emplace_back(static_cast<int16_t>(std::atoi(b.key().c_str())), b.value().is_number() ? b.value().get<uint64_t>() : 0);
          std::sort(hist->BINS.begin(), hist->BINS.end(), [](const ERMHistogramBin& p, const ERMHistogramBin& q) { return p.BIN() < q.BIN(); });
          s->HISTOGRAMS.push_back(std::move(hist));
        }
      if (has(x, "clip")) s->CLIPPED = moments_in(x["clip"]);
      if (has(x, "coverage")) {
        const J& c = x["coverage"];
        s->COVERAGE = std::make_unique<ERMCoverageTallyT>();
        s->COVERAGE->N = unum(c, "n");
        s->COVERAGE->MISSING = unum(c, "missing");
        s->COVERAGE->SUM_D2 = num(c, "sumD2", 0);
        for (const auto& v : c.value("inside", J::array())) s->COVERAGE->INSIDE.push_back(v.get<uint64_t>());
        for (const auto& v : c.value("pit", J::array())) s->COVERAGE->PIT.push_back(v.get<uint64_t>());
        for (const auto& v : c.value("objects", J::array())) s->COVERAGE->OBJECTS.push_back(v.get<uint32_t>());
      }
      a->STRATA.push_back(std::move(s));
    }
  return a;
}
J accumulator_out(const ERMAccumulatorT& a) {
  J j = J::object();
  strata_out(a.STRATA_SETTINGS.get(), j, false);
  j["kind"] = "gp-error-accumulator";
  j["version"] = 1;
  j["mode"] = basis_out(a.BASIS);
  j["clipK"] = a.CLIP_K;
  j["counts"] = counts_out(a.COUNTS.get());
  if (!a.COVERAGE_MODEL.empty()) j["coverageModel"] = a.COVERAGE_MODEL;
  j["strata"] = J::array();
  for (const auto& s : a.STRATA) {
    J x{{"regime", s->REGIME_INDEX}, {"age", s->AGE_INDEX}};
    if (s->MOMENTS) {
      x["n"] = s->MOMENTS->N;
      x["sum"] = s->MOMENTS->SUM;
      x["sq"] = s->MOMENTS->SQUARES;
    }
    x["hist"] = J::array();
    for (const auto& h : s->HISTOGRAMS) {
      J bins = J::object();
      for (const auto& b : h->BINS) bins[std::to_string(b.BIN())] = b.COUNT();
      x["hist"].push_back(bins);
    }
    if (s->CLIPPED) x["clip"] = {{"n", s->CLIPPED->N}, {"sum", s->CLIPPED->SUM}, {"sq", s->CLIPPED->SQUARES}};
    if (s->COVERAGE)
      x["coverage"] = {{"n", s->COVERAGE->N}, {"missing", s->COVERAGE->MISSING}, {"sumD2", s->COVERAGE->SUM_D2},
                       {"inside", s->COVERAGE->INSIDE}, {"pit", s->COVERAGE->PIT}, {"objects", s->COVERAGE->OBJECTS}};
    j["strata"].push_back(x);
  }
  return j;
}

// ── screening ──
std::unique_ptr<ERMScreeningSettingsT> screening_settings_in(const J& j) {
  auto s = std::make_unique<ERMScreeningSettingsT>();
  s->HARD_BODY_RADIUS_M = num(j, "hardBodyRadiusM", 20);
  s->PC_THRESHOLD = num(j, "pcThreshold", 1e-4);
  s->NECESSITY_LEVEL = num(j, "necessityLevel", 0.9973);
  s->BOUND_COVERAGE = num(j, "boundCoverage", 0.9973);
  s->DIRECTIONS = static_cast<uint32_t>(num(j, "directions", 4));
  s->MISS_DISTANCES_M = dvec(j, "missDistancesM");
  s->PAIRS_PER_STRATUM = static_cast<uint32_t>(num(j, "pairsPerStratum", 500));
  s->SEED = static_cast<uint64_t>(num(j, "seed", 1));
  return s;
}
J screening_settings_out(const ERMScreeningSettingsT& s) {
  J j = J::object();
  strata_out(s.STRATA_SETTINGS.get(), j, true);
  j["hardBodyRadiusM"] = s.HARD_BODY_RADIUS_M;
  j["pcThreshold"] = s.PC_THRESHOLD;
  j["necessityLevel"] = s.NECESSITY_LEVEL;
  j["boundCoverage"] = s.BOUND_COVERAGE;
  j["directions"] = s.DIRECTIONS;
  if (!s.MISS_DISTANCES_M.empty()) j["missDistancesM"] = s.MISS_DISTANCES_M;
  j["pairsPerStratum"] = s.PAIRS_PER_STRATUM;
  j["seed"] = s.SEED;
  return j;
}
std::vector<std::unique_ptr<ERMScreeningRowT>> rows_in(const J& rows) {
  std::vector<std::unique_ptr<ERMScreeningRowT>> out;
  for (const auto& r : rows) {
    auto x = std::make_unique<ERMScreeningRowT>();
    x->MISS_M = num(r, "missM", 0);
    x->COLLISION = r.value("collision", false);
    x->CASES = static_cast<uint32_t>(unum(r, "cases"));
    x->PC_ALERT_RATE = num(r, "pcAlertRate", 0);
    x->MEAN_PC = num(r, "meanPc", 0);
    x->BRIER = num(r, "brier", 0);
    x->BOUNDED_SET_ALERT_RATE = num(r, "boundedSetAlertRate", 0);
    x->POSSIBILITY_ALERT_RATE = num(r, "possibilityAlertRate", 0);
    x->MEAN_POSSIBILITY_OF_COLLISION = num(r, "meanPossibilityOfCollision", 0);
    out.push_back(std::move(x));
  }
  return out;
}
std::unique_ptr<ERMScreeningReportT> screening_report_in(const J& j) {
  auto r = std::make_unique<ERMScreeningReportT>();
  if (has(j, "counts")) r->COUNTS = counts_in(j["counts"]);
  else {
    r->COUNTS = std::make_unique<ERMCountsT>();
    r->COUNTS->PAIRS = static_cast<uint32_t>(unum(j, "pairs"));
  }
  if (has(j, "definitions")) {
    const J& d = j["definitions"];
    r->DEFINITIONS = std::make_unique<ERMScreeningDefinitionsT>();
    r->DEFINITIONS->CASES = str(d, "cases");
    r->DEFINITIONS->COLLISION = str(d, "collision");
    r->DEFINITIONS->PROBABILISTIC = str(d, "probabilistic");
    r->DEFINITIONS->BOUNDED_SET = str(d, "boundedSet");
    r->DEFINITIONS->POSSIBILITY = str(d, "possibility");
    r->DEFINITIONS->MISSED_COLLISION = str(d, "missedCollision");
    r->DEFINITIONS->FALSE_ALERT = str(d, "falseAlert");
  }
  if (has(j, "settings")) r->SETTINGS = screening_settings_in(j["settings"]);
  if (has(j, "summary") && j["summary"].is_object())
    for (const auto& kv : j["summary"].items()) {
      auto g = std::make_unique<ERMScreeningGeometryT>();
      g->GEOMETRY = kv.key();
      g->ROWS = rows_in(kv.value());
      r->SUMMARY.push_back(std::move(g));
    }
  if (has(j, "strata"))
    for (const auto& s : j["strata"]) {
      auto x = std::make_unique<ERMScreeningStratumT>();
      x->REGIME = str(s, "regime");
      x->REGIME_INDEX = static_cast<uint32_t>(unum(s, "regimeIndex"));
      x->AGE_INDEX = static_cast<uint32_t>(unum(s, "ageIndex"));
      const auto age = dvec(s, "ageDays");
      if (age.size() == 2) { x->AGE_MIN_DAYS = age[0]; x->AGE_MAX_DAYS = age[1]; }
      x->OBJECTS = static_cast<uint32_t>(unum(s, "objects"));
      x->SAMPLES = unum(s, "samples");
      x->PAIRS = static_cast<uint32_t>(unum(s, "pairs"));
      x->SIGMA_RTN_KM = dvec(s, "sigmaRtnKm");
      if (has(s, "geometries"))
        for (const auto& g : s["geometries"]) {
          auto y = std::make_unique<ERMScreeningGeometryT>();
          y->GEOMETRY = str(g, "geometry");
          y->ROWS = rows_in(has(g, "rows") ? g["rows"] : J::array());
          x->GEOMETRIES.push_back(std::move(y));
        }
      r->STRATA.push_back(std::move(x));
    }
  return r;
}

// ── FFM arcs ──
std::unique_ptr<ERMArcPlanT> plan_in(const J& j) {
  auto p = std::make_unique<ERMArcPlanT>();
  p->TARGET_AGES_DAYS = dvec(j, "targetAgesDays");
  p->EPOCH_TOLERANCE_S = num(j, "epochToleranceSeconds", 0);
  p->TARGET_TOLERANCE_S = num(j, "targetToleranceSeconds", 0);
  p->COVARIANCE_NOTE = str(j, "covariance");
  p->TRUTH_NOTE = str(j, "truth");
  if (has(j, "counts")) p->COUNTS = counts_in(j["counts"]);
  if (has(j, "arcs"))
    for (const auto& a : j["arcs"]) {
      auto x = std::make_unique<ERMArcT>();
      x->ARC = static_cast<uint32_t>(unum(a, "arc"));
      x->NORAD_CAT_ID = static_cast<uint32_t>(unum(a, "norad"));
      x->EPOCH = str(a, "epoch");
      x->REGIME_INDEX = static_cast<uint32_t>(unum(a, "regimeIndex"));
      x->REGIME = str(a, "regime");
      if (has(a, "targets"))
        for (const auto& t : a["targets"]) {
          auto y = std::make_unique<ERMArcTargetT>();
          y->NOMINAL_DAYS = num(t, "nominalDays", 0);
          y->AGE_DAYS = num(t, "ageDays", 0);
          y->EPOCH = str(t, "epoch");
          y->TRUTH = dvec(t, "truth");
          x->TARGETS.push_back(std::move(y));
        }
      x->COVARIANCE = dvec(a, "covariance");
      if (has(a, "processNoise")) x->PROCESS_NOISE = noise_in(a["processNoise"]);
      p->ARCS.push_back(std::move(x));
    }
  return p;
}
J plan_out(const ERMArcPlanT& p) {
  J arcs = J::array();
  for (const auto& a : p.ARCS) {
    J targets = J::array();
    for (const auto& t : a->TARGETS)
      targets.push_back({{"nominalDays", t->NOMINAL_DAYS}, {"ageDays", t->AGE_DAYS}, {"epoch", t->EPOCH}, {"truth", t->TRUTH}});
    J x{{"arc", a->ARC}, {"norad", a->NORAD_CAT_ID}, {"epoch", a->EPOCH}, {"regimeIndex", a->REGIME_INDEX}, {"regime", a->REGIME},
        {"targets", targets}};
    if (!a->COVARIANCE.empty()) x["covariance"] = a->COVARIANCE;
    if (a->PROCESS_NOISE) x["processNoise"] = noise_out(*a->PROCESS_NOISE);
    arcs.push_back(x);
  }
  return {{"kind", "ffm-arc-plan"}, {"version", 1}, {"targetAgesDays", p.TARGET_AGES_DAYS}, {"epochToleranceSeconds", p.EPOCH_TOLERANCE_S},
          {"targetToleranceSeconds", p.TARGET_TOLERANCE_S}, {"covariance", p.COVARIANCE_NOTE}, {"truth", p.TRUTH_NOTE},
          {"counts", counts_out(p.COUNTS.get())}, {"arcs", arcs}};
}
J predictions_out(const ERMArcPredictionsT& p) {
  J arcs = J::array();
  for (const auto& a : p.ARCS) {
    J samples = J::array();
    for (const auto& s : a->SAMPLES) {
      if (s->STATE.empty()) { samples.push_back(nullptr); continue; }
      J x{{"state", s->STATE}};
      if (!s->P0_POSITION.empty()) x["a"] = s->P0_POSITION;
      if (!s->NOISE_RESPONSES.empty()) {
        J u = J::array();
        const size_t width = s->NOISE_RESPONSES.size() / 3;
        for (size_t k = 0; k < 3; ++k)
          u.push_back(std::vector<double>(s->NOISE_RESPONSES.begin() + k * width, s->NOISE_RESPONSES.begin() + (k + 1) * width));
        x["u"] = u;
      }
      samples.push_back(x);
    }
    arcs.push_back({{"arc", a->ARC}, {"samples", samples}});
  }
  return {{"arcs", arcs}};
}
std::unique_ptr<ERMPropagatorCoverageReportT> propagator_coverage_in(const J& j) {
  auto r = std::make_unique<ERMPropagatorCoverageReportT>();
  const auto w = window_in(has(j, "window") ? j["window"] : J());
  r->WINDOW_START = w.first;
  r->WINDOW_STOP = w.second;
  if (has(j, "gate")) r->GATE = gate_in(j["gate"]);
  r->COUNTS = counts_in(has(j, "counts") ? j["counts"] : J());
  if (has(j, "strata"))
    for (const auto& s : j["strata"]) {
      auto x = std::make_unique<ERMPropagatorCoverageStratumT>();
      x->REGIME = str(s, "regime");
      x->REGIME_INDEX = static_cast<uint32_t>(unum(s, "regimeIndex"));
      x->AGE_INDEX = static_cast<uint32_t>(unum(s, "ageIndex"));
      const auto age = dvec(s, "ageDays");
      if (age.size() == 2) { x->AGE_MIN_DAYS = age[0]; x->AGE_MAX_DAYS = age[1]; }
      x->RMS_ERROR_RTN_KM = dvec(s, "rmsErrorRtnKm");
      x->RMS_SIGMA_RTN_KM = dvec(s, "rmsSigmaRtnKm");
      x->RMS_SIGMA_P0_ONLY_RTN_KM = dvec(s, "rmsSigmaP0OnlyRtnKm");
      x->SPECTRAL_DENSITY_M2_S3 = dvec(s, "spectralDensityM2S3");
      if (has(s, "coverage")) x->COVERAGE = coverage_in(s["coverage"]);
      if (has(s, "coverageP0Only")) x->COVERAGE_P0_ONLY = coverage_in(s["coverageP0Only"]);
      r->STRATA.push_back(std::move(x));
    }
  return r;
}
const char* coverage_mode_out(ermCoverageMode m) {
  return m == ermCoverageMode::EpochCovariance ? "epoch" : m == ermCoverageMode::ProcessNoise ? "fit" : "test";
}

// ── common epoch, covariance maps ──
const char* origin_out(ermDifferenceOrigin o) {
  return o == ermDifferenceOrigin::SetMean ? "mean" : o == ermDifferenceOrigin::OneSet ? "set" : "reference";
}
ermDifferenceOrigin origin_in(const std::string& s) {
  return s == "mean" ? ermDifferenceOrigin::SetMean : s == "set" ? ermDifferenceOrigin::OneSet : ermDifferenceOrigin::ReferenceState;
}
const char* method_out(ermMapMethod m) { return m == ermMapMethod::TwoBody ? "two-body" : m == ermMapMethod::Lambert ? "lambert" : "sgp4"; }
ermMapMethod method_in(const std::string& s) { return s == "two-body" ? ermMapMethod::TwoBody : s == "lambert" ? ermMapMethod::Lambert : ermMapMethod::Sgp4; }

std::unique_ptr<ERMCommonEpochT> common_epoch_in(const J& j) {
  auto c = std::make_unique<ERMCommonEpochT>();
  c->UNITS = str(j, "units");
  c->COUNTS = counts_in(has(j, "counts") ? j["counts"] : J());
  if (has(j, "targets"))
    for (const auto& t : j["targets"]) {
      auto x = std::make_unique<ERMCommonEpochResultT>();
      x->NORAD_CAT_ID = static_cast<uint32_t>(unum(t, "norad"));
      x->ORIGIN = origin_in(str(t, "origin"));
      x->EPOCH = str(t, "epoch");
      x->MISSING = str(t, "missing");
      x->ORIGIN_SET = str(t, "originSet");
      x->STATE = dvec(t, "state");
      if (has(t, "sets"))
        for (const auto& s : t["sets"]) {
          auto d = std::make_unique<ERMSetDifferenceT>();
          d->EPOCH = str(s, "epoch");
          d->AGE_DAYS = num(s, "ageDays", 0);
          d->RTN = dvec(s, "rtn");
          x->SETS.push_back(std::move(d));
        }
      if (has(t, "missingSets")) x->MISSING_SETS = svec(t["missingSets"]);
      c->RESULTS.push_back(std::move(x));
    }
  return c;
}
std::unique_ptr<ERMCovarianceMapT> covariance_map_in(const J& j) {
  auto c = std::make_unique<ERMCovarianceMapT>();
  c->UNITS = str(j, "units");
  c->COUNTS = counts_in(has(j, "counts") ? j["counts"] : J());
  if (has(j, "results"))
    for (const auto& r : j["results"]) {
      auto x = std::make_unique<ERMMapResultT>();
      x->NORAD_CAT_ID = static_cast<uint32_t>(unum(r, "norad"));
      x->SET_EPOCH = str(r, "set");
      x->METHOD = method_in(str(r, "method"));
      x->FROM_EPOCH = str(r, "from");
      x->AXES_SET = str(r, "axesSet");
      x->ERROR = str(r, "error");
      if (has(r, "targets"))
        for (const auto& t : r["targets"]) {
          auto y = std::make_unique<ERMMappedCovarianceT>();
          y->EPOCH = str(t, "epoch");
          y->COVARIANCE = dvec(t, "covariance");
          y->STM = dvec(t, "stm");
          y->ERROR = str(t, "error");
          if (has(t, "lambert")) {
            const J& l = t["lambert"];
            y->LAMBERT = std::make_unique<ERMLambertArcT>();
            y->LAMBERT->REVOLUTIONS = static_cast<int32_t>(num(l, "revolutions", 0));
            y->LAMBERT->BRANCH = str(l, "branch");
            y->LAMBERT->V1_KM_S = dvec(l, "v1");
            y->LAMBERT->ENERGY = num(l, "energy", 0);
            y->LAMBERT->SGP4_ENERGY = num(l, "sgp4Energy", 0);
            y->LAMBERT->PERIGEE_RADIUS_KM = num(l, "perigeeRadiusKm", 0);
          }
          x->TARGETS.push_back(std::move(y));
        }
      c->RESULTS.push_back(std::move(x));
    }
  return c;
}

// ── covariance realism ──
const char* axes_out(ermCovarianceAxes a) { return a == ermCovarianceAxes::Uvw ? "UVW" : a == ermCovarianceAxes::Inertial ? "INERTIAL" : "RTN"; }
J side_out(const ERMPairSideT& s) {
  J j = J::object();
  j["covarianceAxes"] = axes_out(s.COVARIANCE_AXES);
  if (!s.SAMPLES.empty()) {
    j["epoch"] = s.EPOCH;
    j["interpolationDegree"] = s.INTERPOLATION_DEGREE;
    J samples = J::array();
    for (const auto& x : s.SAMPLES) {
      J y{{"epoch", x->EPOCH}, {"position", x->POSITION_M}, {"velocity", x->VELOCITY_M_S}};
      if (!x->COVARIANCE.empty()) y["covariance"] = x->COVARIANCE;
      samples.push_back(y);
    }
    j["samples"] = samples;
    return j;
  }
  j["position"] = s.POSITION_M;
  j["velocity"] = s.VELOCITY_M_S;
  if (!s.COVARIANCE.empty()) j["covariance"] = s.COVARIANCE;
  if (!s.COVARIANCE_TERMS.empty()) {
    J terms = J::array();
    for (const auto& t : s.COVARIANCE_TERMS) terms.push_back({{"weight", t->WEIGHT}, {"covariance", t->COVARIANCE}});
    j["covarianceTerms"] = terms;
  }
  return j;
}
std::unique_ptr<ERMPairStatisticsT> pair_statistics_in(const J& j) {
  auto p = std::make_unique<ERMPairStatisticsT>();
  p->AXES_FROM = str(j, "axes") == "RTN of the truth state" ? ermAxesSource::Truth : ermAxesSource::Predicted;
  p->UNITS = str(j, "units");
  p->COUNTS = counts_in(has(j, "counts") ? j["counts"] : J());
  if (has(j, "pairs"))
    for (const auto& r : j["pairs"]) {
      auto x = std::make_unique<ERMPairStatisticT>();
      x->ID = id_text(r, "id");
      x->MISSING = str(r, "missing");
      x->ERROR_RTN_M = dvec(r, "errorRtn");
      x->VELOCITY_ERROR_RTN_M_S = dvec(r, "velocityErrorRtn");
      if (has(r, "predictedInterpolated")) {
        const J& i = r["predictedInterpolated"];
        x->INTERPOLATION_DEGREE = static_cast<uint8_t>(unum(i, "degree"));
        x->INTERPOLATION_FROM = static_cast<uint32_t>(unum(i, "from"));
        x->INTERPOLATION_SAMPLES = static_cast<uint32_t>(unum(i, "samples"));
      }
      x->PREDICTED_RTN = dvec(r, "predictedRtn");
      x->TRUTH_RTN = dvec(r, "truthRtn");
      x->D2_COMBINED = num(r, "d2Combined", std::nan(""));
      x->LOG_DET_COMBINED = num(r, "logDetCombined", std::nan(""));
      x->D2_PREDICTED = num(r, "d2Predicted", std::nan(""));
      x->Z_COMBINED = dvec(r, "zCombined");
      x->Z_PREDICTED = dvec(r, "zPredicted");
      p->STATISTICS.push_back(std::move(x));
    }
  return p;
}
const char* calibration_method_out(ermCalibrationFit m) {
  return m == ermCalibrationFit::AxesMle ? "axes-mle" : m == ermCalibrationFit::CoverageTarget ? "coverage" : "scalar-mle";
}
ermCalibrationFit calibration_method_in(const std::string& s) {
  return s == "axes-mle" ? ermCalibrationFit::AxesMle : s == "coverage" ? ermCalibrationFit::CoverageTarget : ermCalibrationFit::ScalarMle;
}
std::unique_ptr<ERMCalibrationT> calibration_in(const J& j) {
  auto c = std::make_unique<ERMCalibrationT>();
  c->METHOD = calibration_method_in(str(j, "method"));
  c->COVERAGE = num(j, "coverage", 0.95);
  c->RULE = str(j, "rule");
  if (has(j, "strata"))
    for (const auto& s : j["strata"]) {
      auto x = std::make_unique<ERMCalibrationStratumT>();
      x->STRATUM = str(s, "stratum");
      x->N = unum(s, "n");
      x->OBJECTS = static_cast<uint32_t>(unum(s, "objects"));
      x->NOT_POSITIVE_DEFINITE = static_cast<uint32_t>(unum(s, "notPositiveDefinite"));
      x->STATUS = str(s, "status") == "FITTED" ? ermFitStatus::Fitted : str(s, "status") == "INSUFFICIENT" ? ermFitStatus::Insufficient : ermFitStatus::Unspecified;
      if (has(s, "before")) {
        x->BEFORE_MEAN_D2_OVER_3 = num(s["before"], "meanD2Over3", std::nan(""));
        x->BEFORE_COVERAGE_95 = num(s["before"], "coverage95", std::nan(""));
      }
      x->FACTOR = num(s, "factor", std::nan(""));
      x->AXES_FACTORS = dvec(s, "axesFactors");
      if (has(s, "after")) {
        x->AFTER_MEAN_D2_OVER_3 = num(s["after"], "meanD2Over3", std::nan(""));
        x->AFTER_COVERAGE_95 = num(s["after"], "coverage95", std::nan(""));
      }
      c->STRATA.push_back(std::move(x));
    }
  return c;
}
std::unique_ptr<ERMCalibratedCovariancesT> calibrated_in(const J& j) {
  auto c = std::make_unique<ERMCalibratedCovariancesT>();
  c->CALIBRATION_VERSION = str(j, "calibrationVersion");
  c->MODEL_FORM = str(j, "model") == "e14-element-set-model" ? ermModelForm::ElementSetModel : ermModelForm::HorizonFactors;
  c->UNITS = str(j, "units");
  c->RULE = str(j, "rule");
  c->COUNTS = counts_in(has(j, "counts") ? j["counts"] : J());
  if (has(j, "objects"))
    for (const auto& o : j["objects"]) {
      auto x = std::make_unique<ERMCalibratedCovarianceT>();
      x->ID = id_text(o, "id");
      x->REGIME = str(o, "regime");
      x->STATUS = str(o, "status");
      if (has(o, "cell")) {
        const J& c2 = o["cell"];
        x->AGE_INDEX = static_cast<int32_t>(num(c2, "ageIndex", -1));
        x->AGE_DAYS = num(c2, "ageDays", std::nan(""));
        const auto h = dvec(c2, "horizonDays");
        if (h.size() == 2) { x->HORIZON_MIN_DAYS = h[0]; x->HORIZON_MAX_DAYS = h[1]; }
      }
      x->FACTOR = num(o, "factor", std::nan(""));
      x->AXES_FACTORS = dvec(o, "axesFactors");
      x->COVARIANCE_RTN = dvec(o, "covarianceRtn");
      x->COVARIANCE_INERTIAL = dvec(o, "covarianceInertial");
      c->RESULTS.push_back(std::move(x));
    }
  return c;
}
std::unique_ptr<ERMConsiderCovariancesT> dcp_in(const J& j) {
  auto c = std::make_unique<ERMConsiderCovariancesT>();
  c->START = str(j, "start");
  c->LEAD_DAYS = static_cast<uint32_t>(unum(j, "leadDays"));
  c->RULE = str(j, "rule");
  if (has(j, "epochs"))
    for (const auto& e : j["epochs"]) {
      auto x = std::make_unique<ERMConsiderCovarianceT>();
      x->EPOCH = str(e, "epoch");
      x->SECONDS_FROM_START = num(e, "secondsFromStart", 0);
      x->SIGMA_EFFECTIVE = num(e, "sigmaEff", 0);
      x->WEIGHTS = dvec(e, "weights");
      x->WEIGHT_COVERED = num(e, "weightCovered", 0);
      x->SENSITIVITY = dvec(e, "sensitivity");
      x->COVARIANCE = dvec(e, "covariance");
      x->TOTAL = dvec(e, "total");
      c->RESULTS.push_back(std::move(x));
    }
  return c;
}
std::unique_ptr<ERMNoiseResponsesT> noise_responses_in(const J& j) {
  auto n = std::make_unique<ERMNoiseResponsesT>();
  n->START = str(j, "start");
  n->DISCRETIZATION_S = num(j, "discretizationSeconds", 600);
  n->UNITS = str(j, "units");
  if (has(j, "targets"))
    for (const auto& t : j["targets"]) {
      auto x = std::make_unique<ERMNoiseResponseT>();
      x->EPOCH = str(t, "epoch");
      x->STEPS = static_cast<uint32_t>(unum(t, "steps"));
      x->STEP_S = num(t, "stepSeconds", std::nan(""));
      if (has(t, "u")) x->RESPONSES = flat(t["u"]);
      n->RESULTS.push_back(std::move(x));
    }
  return n;
}

// ── element fits ──
std::unique_ptr<ERMResidualStatisticsT> stats_in(const J& j) {
  auto s = std::make_unique<ERMResidualStatisticsT>();
  s->LABEL = str(j, "label");
  s->FROM_EPOCH = str(j, "from");
  s->TO_EPOCH = str(j, "to");
  s->N = static_cast<uint32_t>(unum(j, "n"));
  s->FAILURES = static_cast<uint32_t>(unum(j, "failures"));
  const auto span = has(j, "span") ? svec(j["span"]) : std::vector<std::string>();
  if (span.size() == 2) { s->SPAN_START = span[0]; s->SPAN_STOP = span[1]; }
  s->RMS_3D_KM = num(j, "rms3dKm", std::nan(""));
  s->RMS_PER_COORDINATE_KM = num(j, "rmsPerCoordinateKm", std::nan(""));
  s->RMS_RTN_KM = dvec(j, "rmsRtnKm");
  s->MEAN_RTN_KM = dvec(j, "meanRtnKm");
  s->MAX_3D_KM = num(j, "max3dKm", std::nan(""));
  s->MAX_AT = str(j, "maxAt");
  s->MAX_RTN_KM = dvec(j, "maxRtnKm");
  s->RMS_VELOCITY_KM_S = num(j, "rmsVelocityKmS", std::nan(""));
  if (has(j, "samples"))
    for (const auto& x : j["samples"]) {
      auto y = std::make_unique<ERMResidualSampleT>();
      if (x.is_array() && x.size() == 4) {
        y->EPOCH = x[0].is_string() ? x[0].get<std::string>() : std::string();
        y->R_KM = x[1].get<double>();
        y->T_KM = x[2].get<double>();
        y->N_KM = x[3].get<double>();
      }
      s->SAMPLES.push_back(std::move(y));
    }
  return s;
}
std::unique_ptr<ERMElementFitsT> element_fits_in(const J& j) {
  auto f = std::make_unique<ERMElementFitsT>();
  f->MODEL = str(j, "model");
  f->RESIDUAL_SIGN = str(j, "residualSign");
  f->UNITS = str(j, "units");
  f->COUNTS = counts_in(has(j, "counts") ? j["counts"] : J());
  if (has(j, "fits"))
    for (const auto& r : j["fits"]) {
      auto x = std::make_unique<ERMElementFitT>();
      x->NORAD_CAT_ID = static_cast<uint32_t>(unum(r, "norad"));
      x->OBJECT_NAME = str(r, "objectName");
      x->ERROR = str(r, "error");
      if (has(r, "states")) {
        x->STATES_IN_SPAN = static_cast<uint32_t>(unum(r["states"], "inSpan"));
        x->STATES_FITTED = static_cast<uint32_t>(unum(r["states"], "fitted"));
        x->STATES_WITHOUT_WEIGHTS = static_cast<uint32_t>(unum(r["states"], "withoutWeights"));
        x->STATES_REJECTED = static_cast<uint32_t>(unum(r["states"], "rejected"));
      }
      if (has(r, "stages"))
        for (const auto& s : r["stages"]) {
          auto y = std::make_unique<ERMFitStageT>();
          y->START = str(s, "start");
          y->HALF_WIDTH_S = num(s, "halfWidthSeconds", std::nan(""));
          y->STATES = static_cast<uint32_t>(unum(s, "states"));
          y->ITERATIONS = static_cast<uint32_t>(unum(s, "iterations"));
          y->STOP = str(s, "stop");
          y->REJECTED = static_cast<uint32_t>(unum(s, "rejected"));
          x->STAGES.push_back(std::move(y));
        }
      x->ITERATIONS = static_cast<uint32_t>(unum(r, "iterations"));
      x->CONVERGED = r.value("converged", false);
      x->STOP = str(r, "stop");
      x->CRITERION = str(r, "criterion");
      if (has(r, "rms")) x->RMS = stats_in(r["rms"]);
      if (has(r, "residuals"))
        for (const auto& s : r["residuals"]) {
          auto y = std::make_unique<ERMResidualSampleT>();
          if (s.is_array() && s.size() == 4) {
            y->EPOCH = s[0].get<std::string>();
            y->R_KM = s[1].get<double>();
            y->T_KM = s[2].get<double>();
            y->N_KM = s[3].get<double>();
          }
          x->RESIDUALS.push_back(std::move(y));
        }
      if (has(r, "closure")) {
        const J& c = r["closure"];
        x->CLOSURE = std::make_unique<ERMClosureTestT>();
        x->CLOSURE->DEFINITION = str(c, "definition");
        x->CLOSURE->SPLIT_EPOCH = str(c, "splitEpoch");
        x->CLOSURE->FIT_STATES = static_cast<uint32_t>(unum(c, "fitStates"));
        x->CLOSURE->ITERATIONS = static_cast<uint32_t>(unum(c, "iterations"));
        if (has(c, "rms")) x->CLOSURE->RMS = stats_in(c["rms"]);
        x->CLOSURE->ERROR = str(c, "error");
      }
      x->WEIGHTED_RMS = num(r, "weightedRms", std::nan(""));
      x->CONDITION_NUMBER = num(r, "conditionNumber", std::nan(""));
      if (has(r, "covariance")) {
        const J& c = r["covariance"];
        x->COVARIANCE = std::make_unique<ERMFitCovarianceT>();
        if (has(c, "parameters")) x->COVARIANCE->PARAMETERS = svec(c["parameters"]);
        x->COVARIANCE->EQUINOCTIAL = dvec(c, "equinoctial");
        x->COVARIANCE->SCALE = num(c, "scale", 0);
        x->COVARIANCE->CLASSICAL = dvec(c, "classical");
        x->COVARIANCE->CLASSICAL_UNITS = str(c, "classicalUnits");
        x->COVARIANCE->CARTESIAN_RSW = dvec(c, "cartesianRsw");
        x->COVARIANCE->CARTESIAN_UNITS = str(c, "cartesianUnits");
      }
      x->EPOCH = str(r, "epoch");
      x->EQUINOCTIAL = dvec(r, "equinoctial");
      if (has(r, "bstar")) {
        x->BSTAR_FITTED = r["bstar"].value("fitted", false);
        x->BSTAR_INITIAL = num(r["bstar"], "initial", 0);
      }
      f->FITS.push_back(std::move(x));
    }
  if (has(j, "results"))
    for (const auto& r : j["results"]) {
      auto x = std::make_unique<ERMResidualResultT>();
      x->NORAD_CAT_ID = static_cast<uint32_t>(unum(r, "norad"));
      x->SET_EPOCH = str(r, "set");
      x->LABEL = str(r, "label");
      x->ERROR = str(r, "error");
      if (has(r, "windows"))
        for (const auto& w : r["windows"]) x->WINDOWS.push_back(stats_in(w));
      f->RESIDUAL_RESULTS.push_back(std::move(x));
    }
  return f;
}

// Fit settings as the methods' option keys: a key only where the setting is not the default.
J fit_settings_out(const ERMFitSettingsT& s) {
  J j = J::object();
  if (!s.FROM_EPOCH.empty()) j["from"] = s.FROM_EPOCH;
  if (!s.TO_EPOCH.empty()) j["to"] = s.TO_EPOCH;
  switch (s.EPOCH_CHOICE) {
    case ermFitEpochChoice::Last: j["epoch"] = "last"; break;
    case ermFitEpochChoice::Middle: j["epoch"] = "middle"; break;
    case ermFitEpochChoice::GivenEpoch: j["epoch"] = s.EPOCH; break;
    default: break;
  }
  if (s.STEP_S != 0) j["stepSeconds"] = s.STEP_S;
  if (!s.FIT_BSTAR) j["fitBstar"] = false;
  if (s.BSTAR_FROM_APRIORI) j["bstar"] = "apriori";
  else if (!std::isnan(s.BSTAR)) j["bstar"] = s.BSTAR;
  if (s.WEIGHTING == ermFitWeighting::RtnSigmas) j["weighting"] = "rtn";
  else if (s.WEIGHTING == ermFitWeighting::EphemerisCovariance) j["weighting"] = "covariance";
  if (!s.SIGMA_RTN_KM.empty()) j["sigmaRtnKm"] = s.SIGMA_RTN_KM;
  if (s.VELOCITY) j["velocity"] = true;
  if (s.SIGMA_VELOCITY_KM_S != 0.001) j["sigmaVelocityKmS"] = s.SIGMA_VELOCITY_KM_S;
  if (s.HALF_LIFE_HOURS != 0) j["halfLifeHours"] = s.HALF_LIFE_HOURS;
  if (s.TOWARDS == ermFitFavour::SpanStart) j["towards"] = "start";
  if (s.MAX_ITERATIONS != 100) j["maxIterations"] = s.MAX_ITERATIONS;
  if (s.TOLERANCE != 1e-10) j["tolerance"] = s.TOLERANCE;
  if (s.FLOOR_KM != 1e-6) j["floorKm"] = s.FLOOR_KM;
  if (s.INITIAL == ermFitStart::FromApriori) j["initial"] = "apriori";
  if (s.REJECT_SIGMA != 0) j["rejectSigma"] = s.REJECT_SIGMA;
  if (s.HAS_SCALE_COVARIANCE) j["scaleCovariance"] = s.SCALE_COVARIANCE;
  if (s.RESIDUALS) j["residuals"] = true;
  if (!s.CLOSURE) j["closure"] = false;
  if (s.EPHEMERIS_STREAM >= 0) j["ephemerisStream"] = static_cast<uint64_t>(s.EPHEMERIS_STREAM);
  if (!s.ORIGINATOR.empty()) j["originator"] = s.ORIGINATOR;
  if (!s.CREATION_DATE.empty()) j["creationDate"] = s.CREATION_DATE;
  if (!s.CLASSIFICATION.empty()) j["classification"] = s.CLASSIFICATION;
  if (!s.COMMENT.empty()) j["comment"] = s.COMMENT;
  if (!s.OBJECT_NAME.empty()) j["objectName"] = s.OBJECT_NAME;
  if (!s.OBJECT_ID.empty()) j["objectId"] = s.OBJECT_ID;
  if (s.ELEMENT_SET_NO) j["elementSetNo"] = s.ELEMENT_SET_NO;
  return j;
}
// The defaults a per-object entry restores when it differs from the shared settings by being default.
J fit_default(const std::string& key) {
  static const J d{{"epoch", "first"}, {"stepSeconds", 0}, {"fitBstar", true}, {"weighting", "uniform"}, {"sigmaRtnKm", {1, 1, 1}},
                   {"velocity", false}, {"sigmaVelocityKmS", 0.001}, {"halfLifeHours", 0}, {"towards", "end"}, {"maxIterations", 100},
                   {"tolerance", 1e-10}, {"floorKm", 1e-6}, {"initial", "ephemeris"}, {"rejectSigma", 0}, {"residuals", false}, {"closure", true}};
  return d.contains(key) ? d[key] : J();
}

// ── attach report ──
pvnSourceKind source_kind_in(const std::string& s) {
  return s == "element-set" ? pvnSourceKind::ElementSet : s == "ephemeris" ? pvnSourceKind::Ephemeris : s == "observation" ? pvnSourceKind::Observation : pvnSourceKind::Unspecified;
}
pvnLicenseClass licence_in(const std::string& s) {
  return s == "reproducible" ? pvnLicenseClass::Reproducible : s == "cite-only" ? pvnLicenseClass::CiteOnly : s == "share-alike" ? pvnLicenseClass::ShareAlike
         : s == "non-commercial" ? pvnLicenseClass::NonCommercial : pvnLicenseClass::Unspecified;
}
std::unique_ptr<PVNT> source_in(const J& s, const std::string& producer) {
  auto p = std::make_unique<PVNT>();
  p->SOURCE_ID = str(s, "id");
  p->SOURCE_KIND = source_kind_in(str(s, "kind"));
  p->ORIGINATOR = str(s, "originator");
  p->PROVIDER_ID = str(s, "provider");
  p->PRODUCER = producer;
  if (has(s, "licence")) {
    p->LICENSE_CLASS = licence_in(str(s["licence"], "class"));
    p->LICENSE_ID = str(s["licence"], "id");
  }
  p->LINEAGE = str(s, "lineage");
  return p;
}
std::unique_ptr<ERMRefusedRecordT> refused_in(const J& r) {
  auto x = std::make_unique<ERMRefusedRecordT>();
  x->RECORD = static_cast<uint32_t>(unum(r, "record"));
  x->REASON = str(r, "reason");
  x->OBJECT_KEY = str(r, "object");
  x->FIRST = str(r, "first");
  return x;
}
std::unique_ptr<ERMAttachReportT> attach_report_in(const J& j) {
  auto r = std::make_unique<ERMAttachReportT>();
  r->SOURCE = source_in(has(j, "source") ? j["source"] : J(), str(j, "producer"));
  if (has(j, "counts")) r->COUNTS = counts_in(j["counts"]);
  else {
    r->COUNTS = std::make_unique<ERMCountsT>();
    r->COUNTS->MANEUVERS = static_cast<uint32_t>(unum(j, "maneuvers"));
  }
  if (has(j, "refusedElementSets"))
    for (const auto& x : j["refusedElementSets"]) r->REFUSED_ELEMENT_SETS.push_back(refused_in(x));
  if (has(j, "unmatched")) {
    for (const auto& x : j["unmatched"].value("states", J::array())) r->UNMATCHED_STATES.push_back(refused_in(x));
    for (const auto& x : j["unmatched"].value("operator", J::array())) r->UNMATCHED_OPERATOR.push_back(refused_in(x));
  }
  if (has(j, "objects"))
    for (const auto& o : j["objects"]) {
      auto x = std::make_unique<ERMAttachedObjectT>();
      x->OBJECT_KEY = str(o, "object");
      x->EPOCH = str(o, "epoch");
      x->THEORY = str(o, "theory");
      x->OMM_SHA256 = str(o, "ommSha256");
      x->OCM_SHA256 = str(o, "ocmSha256");
      x->RULE = static_cast<covarianceRule>(has(o, "rule") ? static_cast<int8_t>(num(o, "rule", 0)) : 0);
      x->METHOD = str(o, "method");
      x->PRODUCT = str(o, "product");
      x->CALIBRATED = o.value("calibrated", false);
      x->OMM_COVARIANCE = str(o, "ommCovariance");
      if (has(o, "rows"))
        for (const auto& l : o["rows"]) {
          auto y = std::make_unique<ERMRowLabelT>();
          y->EPOCH = str(l, "epoch");
          y->METHOD = str(l, "method");
          y->BASIS = str(l, "basis");
          y->VERDICT = str(l, "verdict");
          y->REALISM = std::make_unique<CVRT>();
          CVRT& v = *y->REALISM;
          v.RULE = static_cast<covarianceRule>(static_cast<int8_t>(num(l, "rule", 0)));
          v.MODEL_ID = str(l, "model");
          v.REGIME = str(l, "regime");
          v.AGE_DAYS = num(l, "ageDays", std::nan(""));
          if (has(l, "cell")) {
            y->AGE_INDEX = static_cast<int32_t>(num(l["cell"], "ageIndex", -1));
            v.HORIZON_DAYS = num(l["cell"], "horizonDays", std::nan(""));
          }
          v.MEASURED_LINEAGE = str(l, "measuredLineage");
          v.TEST_WINDOW = str(l, "window");
          v.MEAN_D2_OVER_3 = num(l, "meanD2Over3", std::nan(""));
          v.COVERAGE_95 = num(l, "coverage95", std::nan(""));
          v.SAMPLES = static_cast<uint32_t>(unum(l, "samples"));
          v.OBJECTS = static_cast<uint32_t>(unum(l, "objects"));
          v.SCALE_FACTOR = num(l, "scaleFactor", std::nan(""));
          v.CALIBRATION = calibration_in(str(l, "calibration"));
          v.EVIDENCE = str(l, "evidence");
          x->ROWS.push_back(std::move(y));
        }
      if (has(o, "notes"))
        for (const auto& n : o["notes"]) {
          auto y = std::make_unique<ERMRuleNoteT>();
          y->RULE = static_cast<covarianceRule>(static_cast<int8_t>(num(n, "rule", 0)));
          y->REASON = str(n, "reason");
          y->ROW = str(n, "row");
          y->AGE_DAYS = num(n, "ageDays", std::nan(""));
          x->NOTES.push_back(std::move(y));
        }
      r->OBJECTS.push_back(std::move(x));
    }
  return r;
}

// ── the boundary ──

std::string last_error;

// One $ERM record (size-prefixed or plain), verified, unpacked.
std::unique_ptr<ERMT> read_erm(const uint8_t* p, size_t n) {
  if (!p || n < 8) { last_error = "not an $ERM record"; return nullptr; }
  flatbuffers::Verifier::Options vo;
  vo.max_tables = 50000000;
  vo.max_size = 0x7FFFFFFF;
  if (flatbuffers::BufferHasIdentifier(p, ERMIdentifier(), true)) {
    flatbuffers::Verifier v(p, n, vo);
    if (!VerifySizePrefixedERMBuffer(v)) { last_error = "invalid size-prefixed $ERM record"; return nullptr; }
    return std::unique_ptr<ERMT>(GetSizePrefixedERM(p)->UnPack());
  }
  if (flatbuffers::BufferHasIdentifier(p, ERMIdentifier(), false)) {
    flatbuffers::Verifier v(p, n, vo);
    if (!VerifyERMBuffer(v)) { last_error = "invalid $ERM record"; return nullptr; }
    return std::unique_ptr<ERMT>(GetERM(p)->UnPack());
  }
  last_error = "not an $ERM record";
  return nullptr;
}

// The working values of one $ERM record, by its arm.
J erm_to_work(const ERMT& e) {
  if (e.MODEL) return model_out(*e.MODEL);
  if (e.ACCUMULATOR) return accumulator_out(*e.ACCUMULATOR);
  if (e.STRATA_SETTINGS) {
    J j = J::object();
    strata_out(e.STRATA_SETTINGS.get(), j, true);
    return j;
  }
  if (e.GATE) return {{"gate", gate_out(*e.GATE)}};
  if (e.SCALE_OPTIONS) return {{"minimumSamples", e.SCALE_OPTIONS->MINIMUM_SAMPLES}};
  if (e.SCREENING_SETTINGS) return screening_settings_out(*e.SCREENING_SETTINGS);
  if (e.SCREENING_CASES) {
    J pairs = J::array();
    for (const auto& c : e.SCREENING_CASES->CASES)
      pairs.push_back({{"e1", c->ERROR1_KM}, {"c1", c->COVARIANCE1_KM2}, {"e2", c->ERROR2_KM}, {"c2", c->COVARIANCE2_KM2}});
    return {{"pairs", pairs}};
  }
  if (e.ARC_OPTIONS) {
    const ERMArcOptionsT& o = *e.ARC_OPTIONS;
    J j = J::object();
    strata_out(o.STRATA_SETTINGS.get(), j, true);
    if (!o.TARGET_AGES_DAYS.empty()) j["targetAgesDays"] = o.TARGET_AGES_DAYS;
    j["epochToleranceSeconds"] = o.EPOCH_TOLERANCE_S;
    j["targetToleranceSeconds"] = o.TARGET_TOLERANCE_S;
    return j;
  }
  if (e.ARC_PLAN) return plan_out(*e.ARC_PLAN);
  if (e.ARC_PREDICTIONS) return predictions_out(*e.ARC_PREDICTIONS);
  if (e.COVERAGE_OPTIONS) {
    const ERMCoverageOptionsT& o = *e.COVERAGE_OPTIONS;
    J j = J::object();
    strata_out(o.STRATA_SETTINGS.get(), j, true);
    j["mode"] = coverage_mode_out(o.MODE);
    j["window"] = {o.WINDOW_START, o.WINDOW_STOP};
    if (o.GATE) j["gate"] = gate_out(*o.GATE);
    j["clipK"] = o.CLIP_K;
    j["discretizationSeconds"] = o.DISCRETIZATION_S;
    return j;
  }
  if (e.COMMON_EPOCH) {
    J targets = J::array();
    for (const auto& t : e.COMMON_EPOCH->REQUESTS) {
      J x{{"norad", t->NORAD_CAT_ID}, {"epoch", t->EPOCH}, {"sets", t->SETS}, {"origin", origin_out(t->ORIGIN)}, {"afterSeconds", t->AFTER_S}};
      if (!t->ORIGIN_SET.empty()) x["originSet"] = t->ORIGIN_SET;
      targets.push_back(x);
    }
    return {{"targets", targets}};
  }
  if (e.COVARIANCE_MAP) {
    J requests = J::array();
    for (const auto& r : e.COVARIANCE_MAP->REQUESTS) {
      J x{{"norad", r->NORAD_CAT_ID}, {"set", r->SET_EPOCH}, {"covariance", r->COVARIANCE}, {"to", r->TO_EPOCHS},
          {"method", method_out(r->METHOD)}, {"stm", r->INCLUDE_STM}};
      if (!r->FROM_EPOCH.empty()) x["from"] = r->FROM_EPOCH;
      if (!r->AXES_SET.empty()) x["axesSet"] = r->AXES_SET;
      requests.push_back(x);
    }
    return {{"requests", requests}};
  }
  if (e.PAIR_STATISTICS) {
    const ERMPairStatisticsT& p = *e.PAIR_STATISTICS;
    J pairs = J::array();
    for (const auto& x : p.PAIRS) {
      J y{{"predicted", x->PREDICTED ? side_out(*x->PREDICTED) : J(nullptr)}, {"truth", x->TRUTH ? side_out(*x->TRUTH) : J(nullptr)}};
      if (!x->ID.empty()) y["id"] = x->ID;
      pairs.push_back(y);
    }
    return {{"axesFrom", p.AXES_FROM == ermAxesSource::Truth ? "truth" : "predicted"}, {"pairs", pairs}};
  }
  if (e.CALIBRATION) {
    const ERMCalibrationT& c = *e.CALIBRATION;
    J samples = J::array();
    for (const auto& s : c.SAMPLES) {
      J x{{"stratum", s->STRATUM}, {"error", s->ERROR}, {"covariance", s->COVARIANCE}};
      if (!s->OBJECT.empty()) x["object"] = s->OBJECT;
      samples.push_back(x);
    }
    return {{"samples", samples}, {"method", calibration_method_out(c.METHOD)}, {"coverage", c.COVERAGE},
            {"minimumSamples", c.MINIMUM_SAMPLES}, {"minimumObjects", c.MINIMUM_OBJECTS}};
  }
  if (e.CALIBRATED_COVARIANCES) {
    J objects = J::array();
    for (const auto& o : e.CALIBRATED_COVARIANCES->OBJECTS) {
      J x{{"objectFactor", o->OBJECT_FACTOR}, {"covarianceAxes", axes_out(o->COVARIANCE_AXES)}};
      if (!o->ID.empty()) x["id"] = o->ID;
      if (!o->REGIME.empty()) x["regime"] = o->REGIME;
      if (o->SET_NORAD_CAT_ID || !o->SET_EPOCH.empty()) x["set"] = {{"norad", o->SET_NORAD_CAT_ID}, {"epoch", o->SET_EPOCH}};
      if (!o->POSITION_M.empty() || !o->VELOCITY_M_S.empty()) x["state"] = {{"position", o->POSITION_M}, {"velocity", o->VELOCITY_M_S}};
      if (!std::isnan(o->AGE_DAYS)) x["ageDays"] = o->AGE_DAYS;
      if (!std::isnan(o->HORIZON_DAYS)) x["horizonDays"] = o->HORIZON_DAYS;
      if (!o->COVARIANCE.empty()) x["covariance"] = o->COVARIANCE;
      objects.push_back(x);
    }
    return {{"objects", objects}};
  }
  if (e.CONSIDER_COVARIANCES) {
    const ERMConsiderCovariancesT& c = *e.CONSIDER_COVARIANCES;
    size_t k = c.LEAD_DAYS ? c.LEAD_DAYS : static_cast<size_t>(std::llround(std::sqrt(static_cast<double>(c.LEAD_COVARIANCE.size()))));
    J lead = J::array();
    for (size_t i = 0; k && i < k && (i + 1) * k <= c.LEAD_COVARIANCE.size(); ++i)
      lead.push_back(std::vector<double>(c.LEAD_COVARIANCE.begin() + i * k, c.LEAD_COVARIANCE.begin() + (i + 1) * k));
    J segments = J::array();
    for (const auto& s : c.SEGMENTS) segments.push_back({{"from", s->FROM_EPOCH}, {"to", s->TO_EPOCH}, {"lead", s->LEAD}});
    J epochs = J::array();
    for (const auto& x : c.EPOCHS) {
      J y{{"epoch", x->EPOCH}};
      if (!x->SENSITIVITY.empty()) y["sensitivity"] = x->SENSITIVITY;
      if (!x->STM.empty()) y["stm"] = x->STM;
      if (!x->S.empty()) y["s"] = x->S;
      if (!x->BASE.empty()) y["base"] = x->BASE;
      epochs.push_back(y);
    }
    J j{{"leadCovariance", lead}, {"start", c.START}, {"segments", segments}, {"ballisticCoefficient", c.BALLISTIC_COEFFICIENT}, {"epochs", epochs}};
    if (!c.START_STM.empty() || !c.START_S.empty()) j["startSample"] = {{"stm", c.START_STM}, {"s", c.START_S}};
    return j;
  }
  if (e.NOISE_RESPONSES) {
    const ERMNoiseResponsesT& n = *e.NOISE_RESPONSES;
    J samples = J::array();
    for (const auto& s : n.SAMPLES) samples.push_back({{"epoch", s->EPOCH}, {"state", s->STATE}, {"stm", s->STM}});
    return {{"start", n.START}, {"discretizationSeconds", n.DISCRETIZATION_S}, {"samples", samples}, {"targets", n.TARGET_EPOCHS}};
  }
  if (e.ELEMENT_FITS) {
    const ERMElementFitsT& f = *e.ELEMENT_FITS;
    J j = J::object();
    if (f.OPTIONS) {
      J shared = f.OPTIONS->SHARED ? fit_settings_out(*f.OPTIONS->SHARED) : J::object();
      j = shared;
      if (!f.OPTIONS->FITS.empty()) {
        // Each entry overrides the shared settings where it differs from them.
        J fits = J::array();
        for (const auto& s : f.OPTIONS->FITS) {
          const J own = fit_settings_out(*s);
          J x{{"norad", s->NORAD_CAT_ID}};
          for (const auto& kv : own.items())
            if (!shared.contains(kv.key()) || shared[kv.key()] != kv.value()) x[kv.key()] = kv.value();
          for (const auto& kv : shared.items())
            if (!own.contains(kv.key()) && !fit_default(kv.key()).is_null()) x[kv.key()] = fit_default(kv.key());
          fits.push_back(x);
        }
        j["fits"] = fits;
      }
    }
    if (!f.RESIDUAL_REQUESTS.empty() || f.INCLUDE_SAMPLES) {
      J requests = J::array();
      for (const auto& r : f.RESIDUAL_REQUESTS) {
        J windows = J::array();
        for (const auto& w : r->WINDOWS) {
          J x{{"from", w->FROM_EPOCH}, {"to", w->TO_EPOCH}};
          if (!w->LABEL.empty()) x["label"] = w->LABEL;
          windows.push_back(x);
        }
        J x{{"norad", r->NORAD_CAT_ID}, {"set", r->SET_EPOCH}, {"windows", windows}, {"stepSeconds", r->STEP_S}};
        if (r->EPHEMERIS_STREAM >= 0) x["ephemerisStream"] = static_cast<uint64_t>(r->EPHEMERIS_STREAM);
        if (!r->LABEL.empty()) x["label"] = r->LABEL;
        requests.push_back(x);
      }
      j["requests"] = requests;
      j["samples"] = f.INCLUDE_SAMPLES;
    }
    return j;
  }
  last_error = "the $ERM record carries no arm this module reads";
  return J(J::value_t::discarded);
}

// The $ERM a method's result is emitted as, chosen by the result's kind.
std::unique_ptr<ERMT> work_to_erm(const J& j) {
  auto e = std::make_unique<ERMT>();
  const std::string kind = str(j, "kind");
  if (kind == "gp-error-accumulator") e->ACCUMULATOR = accumulator_in(j);
  else if (kind == "gp-error-model" || kind == "ffm-covariance-model" || kind == "e14-factors" || kind == "e14-element-set-model") e->MODEL = model_in(j);
  else if (kind == "screening-evaluation" || kind == "screening-cases") e->SCREENING_REPORT = screening_report_in(j);
  else if (kind == "ffm-arc-plan") e->ARC_PLAN = plan_in(j);
  else if (kind == "ffm-covariance-coverage") e->PROPAGATOR_COVERAGE = propagator_coverage_in(j);
  else if (kind == "common-epoch") e->COMMON_EPOCH = common_epoch_in(j);
  else if (kind == "covariance-map") e->COVARIANCE_MAP = covariance_map_in(j);
  else if (kind == "e14-pair-statistics") e->PAIR_STATISTICS = pair_statistics_in(j);
  else if (kind == "e14-calibration") e->CALIBRATION = calibration_in(j);
  else if (kind == "e14-calibrated-covariance") e->CALIBRATED_COVARIANCES = calibrated_in(j);
  else if (kind == "e14-dcp") e->CONSIDER_COVARIANCES = dcp_in(j);
  else if (kind == "e14-noise-responses") e->NOISE_RESPONSES = noise_responses_in(j);
  else if (kind == "element-fit" || kind == "element-residuals") e->ELEMENT_FITS = element_fits_in(j);
  else e->ATTACH_REPORT = attach_report_in(j);  // attach_covariance and attribute_maneuvers
  return e;
}

std::vector<uint8_t> pack(const ERMT& e) {
  flatbuffers::FlatBufferBuilder fbb(4096);
  FinishSizePrefixedERMBuffer(fbb, CreateERM(fbb, &e));
  return std::vector<uint8_t>(fbb.GetBufferPointer(), fbb.GetBufferPointer() + fbb.GetSize());
}

// ── node config: the recipes of attach_covariance ("attach.") and attribute_maneuvers ("attribute.") ──
// A config value as a working value: numbers that are whole stay integers.
J config_table(const sdm_piv::ConfigTable& t);
J config_value(const sdn::runtime::ConfigEntry* e) {
  using K = sdn::runtime::configValueKind;
  switch (e->KIND()) {
    case K::configValueKind_String: return e->STRING_VALUE() ? J(e->STRING_VALUE()->str()) : J("");
    case K::configValueKind_Number: return whole(e->NUMBER_VALUE());
    case K::configValueKind_Bool: return J(e->BOOL_VALUE());
    case K::configValueKind_StringList: {
      J a = J::array();
      if (e->STRINGS())
        for (const auto* s : *e->STRINGS()) a.push_back(s->str());
      return a;
    }
    case K::configValueKind_NumberList: {
      J a = J::array();
      if (e->NUMBERS())
        for (double x : *e->NUMBERS()) a.push_back(whole(x));
      return a;
    }
    case K::configValueKind_TableList: {
      J a = J::array();
      if (e->TABLES())
        for (const auto* t : *e->TABLES()) a.push_back(config_table(sdm_piv::ConfigTable(t->ENTRIES())));
      return a;
    }
    default: return J();
  }
}
J config_table(const sdm_piv::ConfigTable& t) {
  J j = J::object();
  if (t.entries())
    for (const auto* e : *t.entries())
      if (e->KEY()) j[e->KEY()->str()] = config_value(e);
  return j;
}
// Dotted keys ("attach.source.id") become nested objects; a nested object a host wrote as a one-table list is one.
void put_path(J& into, const std::string& path, J value) {
  J* at = &into;
  size_t start = 0;
  for (size_t dot = path.find('.'); dot != std::string::npos; dot = path.find('.', start)) {
    J& next = (*at)[path.substr(start, dot - start)];
    if (next.is_array() && next.size() == 1 && next[0].is_object()) next = J(next[0]);
    if (!next.is_object()) next = J::object();
    at = &next;
    start = dot + 1;
  }
  (*at)[path.substr(start)] = std::move(value);
}
J unflatten(const J& flat) {
  J out = J::object();
  for (const auto& kv : flat.items()) put_path(out, kv.key(), kv.value());
  return out;
}
// The keys that are objects in a recipe (a host may give an object as a one-table list).
void objects_from_lists(J& j, std::initializer_list<const char*> keys) {
  for (const char* k : keys)
    if (j.contains(k) && j[k].is_array() && j[k].size() == 1 && j[k][0].is_object()) j[k] = J(j[k][0]);
}
// The recipe under `prefix` (a flow configures several nodes), else the config's root keys.
J recipe_from_config(const char* prefix, std::string* error) {
  const sdm_piv::Config config = sdm_piv::get_config();
  if (!config.ok()) {
    *error = "plugin.getConfig: " + config.error_message();
    return J();
  }
  J all = unflatten(config_table(config));
  J recipe = all.contains(prefix) ? all[prefix] : all;
  if (recipe.is_array() && recipe.size() == 1 && recipe[0].is_object()) recipe = J(recipe[0]);
  if (!recipe.is_object()) recipe = J::object();
  objects_from_lists(recipe, {"source"});
  if (recipe.contains("source")) objects_from_lists(recipe["source"], {"licence"});
  if (!recipe.contains("version")) recipe["version"] = 1;  // the recipe's form is the config's; no version tag on the wire
  return recipe;
}

}  // namespace ermb
