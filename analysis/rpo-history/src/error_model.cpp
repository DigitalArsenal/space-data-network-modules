// analysis/rpo-history: the GP error model ($ERM MODEL from
// analysis/gp-error-model) as position covariances by regime and age.
//
// A stratum gives a 6x6 RTN covariance (Lower21: RR, TR, TT, NR, NT, NN, ...,
// km and km/s) for element sets of one orbit regime at one prediction age:
// the clipped covariance when the stratum has one (what the model's realism
// was tested on), else the sample covariance, times the stratum's per-axis
// scale factors s_a s_b when it was scaled. The age of a prediction is its time minus the set's epoch; an age
// outside every bin, or a regime the model lacks, gives no covariance.
namespace {

struct Regime {
  std::string id;
  double altMin = 0, altMax = 0, eMin = 0, eMax = 0;
};

struct Stratum {
  uint32_t regime = 0;
  double ageMin = 0, ageMax = 0;
  bool lastBin = false;
  std::array<double, 21> lower{};  // 6x6 RTN covariance, Lower21, km and km/s
  covarianceCalibration calibration = covarianceCalibration::Unspecified;
};

struct ErrorModel {
  bool present = false;
  std::string id, basisText, propagator;
  bool pooled = false;
  // Statistics of predictions minus later element sets (the hindcast's own
  // truth): the later set's error is already inside each stratum. Any other
  // basis (reference states, a frozen element-set model) describes the error
  // against truth, so a later set compared with it adds its own error.
  bool setDifferences = false;
  std::vector<std::string> sources;
  std::vector<Regime> regimes;
  std::vector<Stratum> strata;

  int regimeOf(double altitude, double eccentricity) const {
    for (size_t i = 0; i < regimes.size(); ++i) {
      const Regime& r = regimes[i];
      if (altitude >= r.altMin && altitude < r.altMax && eccentricity >= r.eMin && eccentricity < r.eMax) return int(i);
    }
    return -1;
  }
  const Stratum* at(int regime, double ageDays) const {
    if (regime < 0 || !(ageDays >= 0)) return nullptr;
    for (const Stratum& s : strata) {
      if (s.regime != uint32_t(regime)) continue;
      if (ageDays >= s.ageMin && (ageDays < s.ageMax || (s.lastBin && ageDays <= s.ageMax))) return &s;
    }
    return nullptr;
  }
  std::string regimeName(int regime) const { return regime >= 0 && size_t(regime) < regimes.size() ? regimes[size_t(regime)].id : ""; }
};

bool loadErrorModel(const ERM* erm, ErrorModel& out) {
  const ERMModel* m = erm->MODEL();
  NEED(m, "The error_model $ERM carries no MODEL.");
  out.present = true;
  out.id = textOf(m->ID());
  if (out.id.empty()) out.id = textOf(m->LABEL());
  out.basisText = textOf(m->BASIS_TEXT());
  out.propagator = textOf(m->PROPAGATOR());
  out.pooled = m->POOLED();
  out.setDifferences = m->BASIS() == ermErrorBasis::SetDifferences;
  if (m->SOURCES()) for (const auto* s : *m->SOURCES()) out.sources.push_back(textOf(s));
  const ERMStrataSettings* settings = m->STRATA_SETTINGS() ? m->STRATA_SETTINGS() : erm->STRATA_SETTINGS();
  NEED(settings && settings->REGIMES() && settings->REGIMES()->size() > 0, "The error model names no regimes (STRATA_SETTINGS.REGIMES).");
  for (const auto* r : *settings->REGIMES()) {
    Regime g;
    g.id = textOf(r->ID());
    g.altMin = r->ALTITUDE_MIN_KM();
    g.altMax = r->ALTITUDE_MAX_KM();
    g.eMin = r->ECCENTRICITY_MIN();
    g.eMax = r->ECCENTRICITY_MAX();
    out.regimes.push_back(g);
  }
  NEED(m->STRATA() && m->STRATA()->size() > 0, "The error model has no STRATA.");
  std::map<uint32_t, double> lastAge;
  for (const auto* s : *m->STRATA()) {
    const flatbuffers::Vector<double>* lower = nullptr;
    if (s->CLIPPED() && s->CLIPPED()->COVARIANCE() && s->CLIPPED()->COVARIANCE()->size() >= 6) lower = s->CLIPPED()->COVARIANCE();
    else if (s->COVARIANCE() && s->COVARIANCE()->size() >= 6) lower = s->COVARIANCE();
    if (!lower) continue;
    Stratum t;
    t.regime = s->REGIME_INDEX();
    if (t.regime >= out.regimes.size()) continue;
    t.ageMin = s->AGE_MIN_DAYS();
    t.ageMax = s->AGE_MAX_DAYS();
    // A frozen model may name its age bin by index only (STRATA_SETTINGS.AGE_BINS).
    if (!(t.ageMax > t.ageMin) && settings->AGE_BINS() && s->AGE_INDEX() < settings->AGE_BINS()->size()) {
      t.ageMin = settings->AGE_BINS()->Get(s->AGE_INDEX())->MIN_DAYS();
      t.ageMax = settings->AGE_BINS()->Get(s->AGE_INDEX())->MAX_DAYS();
    }
    if (!(t.ageMax > t.ageMin)) continue;
    // A position-only stratum (6 values) leaves the velocity block zero.
    for (size_t i = 0; i < std::min<size_t>(21, lower->size()); ++i) t.lower[i] = lower->Get(flatbuffers::uoffset_t(i));
    if (s->SCALE() && s->SCALE()->FACTORS() && s->SCALE()->FACTORS()->size() >= 3) {
      const double f[3] = {s->SCALE()->FACTORS()->Get(0), s->SCALE()->FACTORS()->Get(1), s->SCALE()->FACTORS()->Get(2)};
      for (int i = 0; i < 6; ++i)
        for (int j = 0; j <= i; ++j) t.lower[size_t(i * (i + 1) / 2 + j)] *= f[i % 3] * f[j % 3];
    }
    bool finite = true;
    for (double v : t.lower) finite = finite && std::isfinite(v);
    if (!finite || !(t.lower[0] > 0 && t.lower[2] > 0 && t.lower[5] > 0)) continue;
    t.calibration = s->CALIBRATION();
    lastAge[t.regime] = std::max(lastAge.count(t.regime) ? lastAge[t.regime] : 0.0, t.ageMax);
    out.strata.push_back(t);
  }
  for (Stratum& s : out.strata) s.lastBin = s.ageMax >= lastAge[s.regime];
  NEED(!out.strata.empty(), "The error model has no stratum with a position covariance.");
  return true;
}
}  // namespace
