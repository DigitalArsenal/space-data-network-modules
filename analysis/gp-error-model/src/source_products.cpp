// Covariance for every object, by the rule order of the catalog pipeline, written into SDS records. Built in one
// translation unit after gp_error_model.cpp and covariance_realism.cpp, whose element loading, regime rule,
// age bins, model reading, interpolation and RTN algebra it uses.
//
// attach_covariance
//   elements  $OMM   the element sets of one source, SGP4 (or SGP4-XP, passed through)
//   states    $OEM   each set's states at its epoch plus ages (analysis/epoch-state derive_omm), GCRF
//   operator  $OEM   optional: the operator's ephemeris with its covariance (COVARIANCE_MATRIX_LINES), or
//             $OCM   a fit's state and formal covariance (COVARIANCE_DATA)
//   models    $ERM   MODEL records: the element-set models (E14 S3-KC) with their held-out verdicts, SOURCES and POOLED
//   config           the recipe (plugin.getConfig, keys under "attach.", else the root): the source's attribution, the
//                    producer, latestOnly, maxOperatorRows and the measured realism factors (src/erm_bridge.cpp)
//   -> ocm    $OCM   state and covariance per object: PROVENANCE (PVN) names the source, COV_REALISM holds one CVR per covariance epoch
//      omm    $OMM   the element set with its COVARIANCE, its PROVENANCE and the CVR of the row the covariance is of (COV_REALISM)
//      report $ERM   ATTACH_REPORT, per object: the rule that applied, why the earlier rules did not, every row's cell and verdict
//
// The first rule that applies gives the covariance of an object's product:
//   1  the operator's covariance, as supplied (a state block with covariance lines)
//   2  the formal covariance of a fit, times the realism factor measured for that source and class (E6: laser-range
//      fits measured 16-21 times too small)
//   3  the source's own model of its element sets' error by regime and age (E14 S3-KC)
//   4  the model pooled over all sources, for a source with no model of its own
// Rules 3 and 4 cover every object that has an SGP4 element set in a regime the model covers.
// A covariance's CVR is Calibrated only where the numbers of its cell pass the rule on the held-out window, measured on
// the lineage the source belongs to (mean d^2/3 in [0.8, 1.25], 95 % coverage in [0.93, 0.97], from at least 30 samples
// of at least 3 objects); everywhere else it is Uncalibrated with the cell's numbers, or without them for a source never
// measured. The verdict is computed from the numbers, never read from the model file.
//
// attribute_maneuvers
//   maneuvers $MNV, config (keys under "attribute.", else the root) -> maneuvers $MNV, report $ERM ATTACH_REPORT: every record names its source in PROVENANCE (a PRODUCER the record
//   already names, the detector, stays), and the report counts them.
//
// Errors are returned, not thrown: the module is built without exceptions.

namespace sp {

using Json = nlohmann::json;
using namespace covreal;

constexpr size_t kMaxRecordsPerPort = 400000;
constexpr double kDay = 86400.0;
// The software that made a record, when the recipe names none.
constexpr const char* kDefaultProducer = "SDN catalog pipeline";

// ── small utilities ─────────────────────────────────────────────────────────────────────────────────────────────

std::string key_of(uint32_t norad, const std::string& id, const std::string& name) {
  if (norad > 0) return "NORAD:" + std::to_string(norad);
  if (!id.empty()) return id;
  return name;
}
bool contains(const std::vector<std::string>& list, const std::string& value) {
  return std::find(list.begin(), list.end(), value) != list.end();
}
Json finite_or_null(double x) { return std::isfinite(x) ? Json(x) : Json(nullptr); }
std::string sha256_hex(const std::vector<uint8_t>& bytes) {
  ephem::Sha256 h;
  h.update(bytes.data(), bytes.size());
  return h.hex();
}
std::string string_list(const Json& j, const char* key, std::vector<std::string>* out) {
  out->clear();
  if (!j.is_object() || !j.contains(key)) return {};
  if (!j[key].is_array()) return std::string(key) + " is an array of strings.";
  for (const auto& x : j[key]) {
    if (!x.is_string()) return std::string(key) + " is an array of strings.";
    out->push_back(x.get<std::string>());
  }
  return {};
}

// ── the recipe ──────────────────────────────────────────────────────────────────────────────────────────────────

struct Attribution {
  std::string id, kind, lineage, originator, provider, fit_class, licence_class, licence_id;
  pvnSourceKind source_kind = pvnSourceKind::Unspecified;
  pvnLicenseClass licence = pvnLicenseClass::Unspecified;
};
struct Verdict {
  std::string decision;
  double horizon = NAN, mean_d2 = NAN, coverage = NAN;
  uint64_t samples = 0, objects = 0;
};
struct Model {
  std::string id, window, evidence, rule;
  std::vector<std::string> lineages, sources;
  bool pooled = false;
  SetModel sm;
  std::map<std::pair<int, int>, Verdict> cells;
};
struct Realism {
  std::vector<std::string> sources;
  std::string cls, evidence, window;
  double factor = NAN, mean_d2 = NAN, coverage = NAN;
  uint64_t samples = 0, objects = 0;
};
struct Recipe {
  Attribution a;
  std::string producer = kDefaultProducer, created;
  bool latest_only = true;
  size_t max_operator_rows = 8;
  std::vector<Model> models;
  std::vector<Realism> realism;
};

std::string read_attribution(const Json& j, Attribution* a) {
  if (!j.is_object() || !j.contains("source") || !j["source"].is_object()) return "recipe.source is required: {id, kind, originator, provider, lineage, licence}.";
  const Json& s = j["source"];
  a->id = json_string(s, "id");
  a->kind = json_string(s, "kind");
  a->lineage = json_string(s, "lineage");
  a->originator = json_string(s, "originator");
  a->provider = json_string(s, "provider");
  a->fit_class = json_string(s, "fitClass");
  if (s.contains("licence") && s["licence"].is_object()) {
    a->licence_class = json_string(s["licence"], "class");
    a->licence_id = json_string(s["licence"], "id");
  }
  if (a->id.empty()) return "recipe.source.id is required.";
  if (a->kind == "element-set") a->source_kind = pvnSourceKind::ElementSet;
  else if (a->kind == "ephemeris") a->source_kind = pvnSourceKind::Ephemeris;
  else if (a->kind == "observation") a->source_kind = pvnSourceKind::Observation;
  else return "recipe.source.kind is element-set, ephemeris or observation.";
  if (a->originator.empty()) return "recipe.source.originator is required: every record names its source.";
  if (a->provider.empty()) return "recipe.source.provider is required: every record names its publishing provider.";
  if (a->licence_class.empty()) return "recipe.source.licence.class is required: every record carries its source's licence class.";
  if (a->licence_class == "reproducible") a->licence = pvnLicenseClass::Reproducible;
  else if (a->licence_class == "cite-only") a->licence = pvnLicenseClass::CiteOnly;
  else if (a->licence_class == "share-alike") a->licence = pvnLicenseClass::ShareAlike;
  else if (a->licence_class == "non-commercial") a->licence = pvnLicenseClass::NonCommercial;
  else return "recipe.source.licence.class is reproducible, cite-only, share-alike or non-commercial.";
  if (a->lineage.empty()) a->lineage = a->id;
  return {};
}

std::string read_model(const Json& j, Model* m) {
  if (!j.is_object()) return "each model is an object.";
  m->id = json_string(j, "id");
  if (m->id.empty()) m->id = json_string(j, "calibrationVersion");
  if (m->id.empty()) return "each model needs an id.";
  std::string e = string_list(j, "sources", &m->sources);
  if (!e.empty()) return e;
  m->pooled = j.contains("pooled") && j["pooled"].is_boolean() && j["pooled"].get<bool>();
  if (j.contains("measuredOn") && j["measuredOn"].is_object()) {
    e = string_list(j["measuredOn"], "lineages", &m->lineages);
    if (!e.empty()) return e;
    m->window = json_string(j["measuredOn"], "window");
    m->evidence = json_string(j["measuredOn"], "evidence");
    m->rule = json_string(j["measuredOn"], "rule");
  }
  e = read_set_model(j, &m->sm);
  if (!e.empty()) return e;
  if (j.contains("cells")) {
    if (!j["cells"].is_array()) return "cells is an array.";
    for (const auto& c : j["cells"]) {
      if (!c.is_object() || !c.contains("regimeIndex") || !c["regimeIndex"].is_number_integer() || !c.contains("ageIndex") || !c["ageIndex"].is_number_integer())
        return "each cell needs integer regimeIndex and ageIndex.";
      Verdict v;
      v.decision = json_string(c, "decision");
      v.horizon = json_number(c, "horizonDays", NAN);
      v.mean_d2 = json_number(c, "meanD2Over3", NAN);
      v.coverage = json_number(c, "coverage95", NAN);
      v.samples = static_cast<uint64_t>(std::max(0.0, json_number(c, "samples", 0)));
      v.objects = static_cast<uint64_t>(std::max(0.0, json_number(c, "objects", 0)));
      m->cells[{c["regimeIndex"].get<int>(), c["ageIndex"].get<int>()}] = v;
    }
  }
  return {};
}

std::string read_recipe(const Json& j, Recipe* r) {
  if (j.is_discarded() || !j.is_object()) return "recipe must be a JSON object.";
  if (json_number(j, "version", 0) != 1) return "recipe.version is 1.";
  std::string e = read_attribution(j, &r->a);
  if (!e.empty()) return e;
  if (!json_string(j, "producer").empty()) r->producer = json_string(j, "producer");
  r->created = json_string(j, "created");
  if (j.contains("latestOnly") && j["latestOnly"].is_boolean()) r->latest_only = j["latestOnly"].get<bool>();
  if (j.contains("maxOperatorRows")) {
    if (!j["maxOperatorRows"].is_number_unsigned() || j["maxOperatorRows"].get<size_t>() < 1) return "maxOperatorRows is a positive integer.";
    r->max_operator_rows = j["maxOperatorRows"].get<size_t>();
  }
  if (j.contains("models")) {
    if (!j["models"].is_array()) return "models is an array.";
    for (const auto& m : j["models"]) {
      Model model;
      e = read_model(m, &model);
      if (!e.empty()) return e;
      r->models.push_back(std::move(model));
    }
  }
  if (j.contains("realism")) {
    if (!j["realism"].is_array()) return "realism is an array.";
    for (const auto& x : j["realism"]) {
      Realism s;
      if (!x.is_object()) return "each realism entry is an object.";
      e = string_list(x, "sources", &s.sources);
      if (!e.empty()) return e;
      s.cls = json_string(x, "class");
      s.factor = json_number(x, "factor", NAN);
      if (s.cls.empty() || !(s.factor > 0) || !std::isfinite(s.factor)) return "each realism entry needs a class and a positive factor.";
      s.mean_d2 = json_number(x, "meanD2Over3", NAN);
      s.coverage = json_number(x, "coverage95", NAN);
      s.samples = static_cast<uint64_t>(std::max(0.0, json_number(x, "samples", 0)));
      s.objects = static_cast<uint64_t>(std::max(0.0, json_number(x, "objects", 0)));
      s.evidence = json_string(x, "evidence");
      s.window = json_string(x, "window");
      r->realism.push_back(std::move(s));
    }
  }
  return {};
}

// ── labels ──────────────────────────────────────────────────────────────────────────────────────────────────────

struct Label {
  int rule = 0;
  std::string method, model_id, regime, verdict, calibration, basis, window, evidence, measured_lineage;
  int age_index = -1;
  double age_days = NAN, horizon = NAN, mean_d2 = NAN, coverage = NAN, scale = NAN;
  uint64_t samples = 0, objects = 0;
  bool calibrated() const { return calibration == "CALIBRATED"; }
};

// The CVR's own rule for its verdict: Calibrated when mean d^2/3 lies in [0.8, 1.25] and the 95 % coverage in
// [0.93, 0.97], from at least 30 samples of at least 3 objects of the lineage the covariance's source has; Uncalibrated
// otherwise, a cell never measured included. The verdict follows from the numbers beside it.
std::string verdict_of(const Label& l, bool measured_here) {
  const bool passed = measured_here && std::isfinite(l.mean_d2) && std::isfinite(l.coverage) && l.mean_d2 >= 0.8 && l.mean_d2 <= 1.25 &&
                      l.coverage >= 0.93 && l.coverage <= 0.97 && l.samples >= 30 && l.objects >= 3;
  return passed ? "CALIBRATED" : "UNCALIBRATED";
}

Json label_json(const Label& l) {
  Json j = {{"rule", l.rule}, {"method", l.method}, {"calibration", l.calibration}, {"basis", l.basis}};
  if (!l.model_id.empty()) j["model"] = l.model_id;
  if (!l.regime.empty()) j["regime"] = l.regime;
  if (std::isfinite(l.age_days)) j["ageDays"] = l.age_days;
  if (l.age_index >= 0) j["cell"] = {{"ageIndex", l.age_index}, {"horizonDays", finite_or_null(l.horizon)}};
  if (!l.verdict.empty()) j["verdict"] = l.verdict;
  if (std::isfinite(l.mean_d2)) j["meanD2Over3"] = l.mean_d2;
  if (std::isfinite(l.coverage)) j["coverage95"] = l.coverage;
  if (l.samples) j["samples"] = l.samples;
  if (l.objects) j["objects"] = l.objects;
  if (std::isfinite(l.scale)) j["scaleFactor"] = l.scale;
  if (!l.window.empty()) j["window"] = l.window;
  if (!l.evidence.empty()) j["evidence"] = l.evidence;
  if (!l.measured_lineage.empty()) j["measuredLineage"] = l.measured_lineage;
  return j;
}

// ── inputs ──────────────────────────────────────────────────────────────────────────────────────────────────────

// The records of every frame of a port, each whole, with its file identifier. A frame is a stream of size-prefixed
// records (zero-length prefixes are padding), or one plain FlatBuffer, which is how analysis/maneuver-detection
// frames each $MNV.
struct RawRecord {
  std::vector<uint8_t> bytes;
  std::string ident;
  bool prefixed = true;
};
bool port_records(const char* port, const char* plain_ident, std::vector<RawRecord>* out, std::string* error) {
  for (uint32_t ordinal = 0;; ++ordinal) {
    const int32_t index = plugin_find_input_index(port, ordinal);
    if (index < 0) break;
    const plugin_input_frame_t* f = plugin_get_input_frame(static_cast<uint32_t>(index));
    const uint8_t* p = f ? f->payload : nullptr;
    const size_t n = p ? f->payload_length : 0;
    if (plain_ident && n >= 8 && std::memcmp(p + 4, plain_ident, 4) == 0) {
      // The file identifier of a plain FlatBuffer sits after its root offset; a size-prefixed stream has it after the prefix.
      // The bytes stay as they are: a prefix put in front would shift the alignment its doubles were built for.
      RawRecord r;
      r.bytes.assign(p, p + n);
      r.ident.assign(plain_ident, 4);
      r.prefixed = false;
      out->push_back(std::move(r));
      continue;
    }
    size_t at = 0;
    while (at < n) {
      if (n - at < 4) { *error = std::string("truncated size-prefixed record on port ") + port; return false; }
      const uint32_t len = flatbuffers::ReadScalar<uint32_t>(p + at);
      if (len == 0) { at += 4; continue; }  // padding
      if (len < 4 || len > n - at - 4) { *error = std::string("invalid record length on port ") + port; return false; }
      RawRecord r;
      r.bytes.assign(p + at, p + at + 4 + len);
      if (len >= 8) r.ident.assign(reinterpret_cast<const char*>(p + at + 8), 4);  // after the prefix and the root offset
      at += 4 + len;
      if (out->size() >= kMaxRecordsPerPort) { *error = std::string("too many records on port ") + port; return false; }
      out->push_back(std::move(r));
    }
  }
  return true;
}

template <class Verify, class VerifyPrefixed>
bool verified(const RawRecord& raw, Verify verify, VerifyPrefixed verify_prefixed) {
  flatbuffers::Verifier verifier(raw.bytes.data(), raw.bytes.size());
  return raw.prefixed ? verify_prefixed(verifier) : verify(verifier);
}

struct SetRec {
  std::vector<uint8_t> bytes;
  bool prefixed = true;
  std::string key, name, object_id, epoch_text;
  uint32_t norad = 0;
  Instant epoch;
  uint32_t order = 0;
  meanElementSource theory = meanElementSource::SGP4;
  double alt_km = NAN, ecc = NAN;
  std::string unusable;  // why the set cannot be given a covariance
};

bool load_sets(const std::vector<RawRecord>& records, std::vector<SetRec>* sets, Json* refused, std::string* error) {
  uint32_t order = 0;
  for (const RawRecord& raw : records) {
    ++order;
    if (raw.ident != "$OMM" || !verified(raw, [](flatbuffers::Verifier& v) { return VerifyOMMBuffer(v); }, [](flatbuffers::Verifier& v) { return VerifySizePrefixedOMMBuffer(v); })) {
      *error = "invalid $OMM record on port elements";
      return false;
    }
    const OMM* omm = raw.prefixed ? GetSizePrefixedOMM(raw.bytes.data()) : GetOMM(raw.bytes.data());
    SetRec s;
    s.bytes = raw.bytes;
    s.prefixed = raw.prefixed;
    s.order = order;
    s.norad = omm->NORAD_CAT_ID();
    s.object_id = omm->OBJECT_ID() ? omm->OBJECT_ID()->str() : "";
    s.name = omm->OBJECT_NAME() ? omm->OBJECT_NAME()->str() : "";
    s.key = key_of(s.norad, s.object_id, s.name);
    s.theory = omm->MEAN_ELEMENT_THEORY();
    if (s.key.empty()) { refused->push_back({{"record", order - 1}, {"reason", "missing-object-identity"}}); continue; }
    if (!parse_instant(omm->EPOCH(), &s.epoch)) { refused->push_back({{"object", s.key}, {"record", order - 1}, {"reason", "invalid-epoch"}}); continue; }
    s.epoch_text = omm->EPOCH()->str();
    if (s.theory == meanElementSource::SGP4) {
      const double el[] = {omm->MEAN_MOTION(), omm->ECCENTRICITY(), omm->INCLINATION(), omm->RA_OF_ASC_NODE(), omm->ARG_OF_PERICENTER(), omm->MEAN_ANOMALY(), omm->BSTAR()};
      bool finite = true;
      for (double x : el) finite = finite && std::isfinite(x);
      elsetrec rec;
      std::memset(&rec, 0, sizeof(rec));
      char satn[9] = "00000";
      const double epoch = static_cast<double>(s.epoch.day) + kSgp4EpochFromUnixDays + s.epoch.sec / 86400.0;
      if (!finite || !(omm->MEAN_MOTION() > 0) ||
          !SGP4Funcs::sgp4init(wgs72, 'i', satn, epoch, omm->BSTAR(), 0.0, 0.0, omm->ECCENTRICITY(), omm->ARG_OF_PERICENTER() * kDeg,
                               omm->INCLINATION() * kDeg, omm->MEAN_ANOMALY() * kDeg, omm->MEAN_MOTION() * 2.0 * kPi / 1440.0,
                               omm->RA_OF_ASC_NODE() * kDeg, rec) ||
          rec.error != 0) {
        s.unusable = "sgp4-init";
      } else {
        const double n_rad_s = rec.no_unkozai / 60.0;
        s.alt_km = std::cbrt(kMuWgs72 / (n_rad_s * n_rad_s)) - kReWgs72;
        s.ecc = omm->ECCENTRICITY();
      }
    } else if (s.theory == meanElementSource::SGP4XP) {
      s.unusable = "sgp4xp-no-propagator-or-error-model";
    } else {
      s.unusable = std::string("mean-element-theory-not-sgp4:") + EnumNamemeanElementSource(s.theory);
    }
    sets->push_back(std::move(s));
  }
  // One set per object and epoch (within a second): the later record is a republication.
  std::stable_sort(sets->begin(), sets->end(), [](const SetRec& a, const SetRec& b) {
    if (a.key != b.key) return a.key < b.key;
    return before(a.epoch, b.epoch);
  });
  std::vector<SetRec> unique;
  for (SetRec& s : *sets) {
    if (!unique.empty() && unique.back().key == s.key && seconds_between(unique.back().epoch, s.epoch) < 1.0) {
      if (s.order > unique.back().order) unique.back() = std::move(s);
      continue;
    }
    unique.push_back(std::move(s));
  }
  sets->swap(unique);
  return true;
}

struct Row {
  Instant t;
  std::string text;
  double x[6] = {};
};
struct CovLine {
  std::string frame_name;  // OEM per-matrix override; otherwise block frame.
  Instant t;
  std::string text;
  std::array<double, 21> c{};
};
struct Block {
  std::string key, name, object_id, frame_name, cov_frame_name, comment;
  uint32_t norad = 0;
  std::shared_ptr<RFMT> frame, cov_frame;
  std::vector<Row> rows;
  std::vector<CovLine> cov;
  bool is_ocm = false;
};

std::shared_ptr<RFMT> unpack_frame(const RFM* f) {
  if (!f) return nullptr;
  return std::shared_ptr<RFMT>(f->UnPack());
}
std::string frame_name_of(const RFM* f) {
  if (!f) return "";
  if (f->NAME() && f->NAME()->size() > 0) return f->NAME()->str();
  if (const auto* c = f->REFERENCE_FRAME_as_CelestialFrameWrapper()) return EnumNameCelestialFrame(c->frame());
  if (const auto* o = f->REFERENCE_FRAME_as_OrbitFrameWrapper()) return EnumNameOrbitFrame(o->frame());
  return "";
}
std::string upper(std::string s) {
  std::transform(s.begin(), s.end(), s.begin(), [](unsigned char c) { return static_cast<char>(std::toupper(c)); });
  return s;
}

// The covariance's axes: the RTN family, or the state's own inertial axes (where a covariance with no stated frame
// belongs, per CCSDS). Anything else is refused rather than guessed.
enum class CovAxes { Rtn, State, Unsupported };
CovAxes classify_axes(const std::string& cov_frame, const std::string& state_frame) {
  const std::string n = upper(cov_frame);
  if (n.empty()) return CovAxes::State;
  if (n == "RTN" || n == "RSW" || n == "RIC" || n == "UVW" || n == "RSW_INERTIAL" || n == "RSW_ROTATING") return CovAxes::Rtn;
  if (n == upper(state_frame)) return CovAxes::State;
  return CovAxes::Unsupported;
}

bool read_oem_blocks(const RawRecord& raw, std::vector<Block>* blocks, std::string* error) {
  if (!verified(raw, [](flatbuffers::Verifier& v) { return VerifyOEMBuffer(v); }, [](flatbuffers::Verifier& v) { return VerifySizePrefixedOEMBuffer(v); })) {
    *error = "invalid $OEM record";
    return false;
  }
  const OEM* oem = raw.prefixed ? GetSizePrefixedOEM(raw.bytes.data()) : GetOEM(raw.bytes.data());
  if (!oem->EPHEMERIS_DATA_BLOCK()) return true;
  for (const ephemerisDataBlock* b : *oem->EPHEMERIS_DATA_BLOCK()) {
    Block blk;
    const CAT* obj = b->OBJECT();
    blk.norad = obj ? obj->NORAD_CAT_ID() : 0;
    blk.object_id = obj && obj->OBJECT_ID() ? obj->OBJECT_ID()->str() : "";
    blk.name = obj && obj->OBJECT_NAME() ? obj->OBJECT_NAME()->str() : "";
    blk.key = key_of(blk.norad, blk.object_id, blk.name);
    blk.comment = b->COMMENT() ? b->COMMENT()->str() : "";
    blk.frame = unpack_frame(b->REFERENCE_FRAME());
    blk.frame_name = frame_name_of(b->REFERENCE_FRAME());
    blk.cov_frame = unpack_frame(b->COV_REFERENCE_FRAME());
    blk.cov_frame_name = frame_name_of(b->COV_REFERENCE_FRAME());
    if (b->STEP_SIZE() > 0 && b->EPHEMERIS_DATA()) {
      const unsigned width = std::max<unsigned>(6, b->STATE_VECTOR_SIZE());
      Instant start;
      if (!parse_instant(b->START_TIME(), &start)) { *error = "a compact ephemeris block needs START_TIME"; return false; }
      for (size_t i = 0; i * width + 6 <= b->EPHEMERIS_DATA()->size(); ++i) {
        Row row;
        row.t = start;
        row.t.sec += static_cast<double>(i) * b->STEP_SIZE();
        while (row.t.sec >= kDay) { row.t.sec -= kDay; row.t.day += 1; }
        for (int k = 0; k < 6; ++k) row.x[k] = b->EPHEMERIS_DATA()->Get(i * width + k);
        blk.rows.push_back(row);
      }
    } else if (b->EPHEMERIS_DATA_LINES()) {
      for (const ephemerisDataLine* line : *b->EPHEMERIS_DATA_LINES()) {
        Row row;
        if (!parse_instant(line->EPOCH(), &row.t)) { *error = "an ephemeris line has no valid EPOCH"; return false; }
        row.text = line->EPOCH()->str();
        row.x[0] = line->X(); row.x[1] = line->Y(); row.x[2] = line->Z();
        row.x[3] = line->X_DOT(); row.x[4] = line->Y_DOT(); row.x[5] = line->Z_DOT();
        blk.rows.push_back(row);
      }
    }
    if (b->COVARIANCE_MATRIX_LINES()) {
      for (const covarianceMatrixLine* line : *b->COVARIANCE_MATRIX_LINES()) {
        CovLine c;
        if (!parse_instant(line->EPOCH(), &c.t)) { *error = "a covariance line has no valid EPOCH"; return false; }
        c.text = line->EPOCH()->str();
        c.frame_name = frame_name_of(line->COV_REFERENCE_FRAME());
        const double v[21] = {line->CX_X(), line->CY_X(), line->CY_Y(), line->CZ_X(), line->CZ_Y(), line->CZ_Z(), line->CX_DOT_X(),
                              line->CX_DOT_Y(), line->CX_DOT_Z(), line->CX_DOT_X_DOT(), line->CY_DOT_X(), line->CY_DOT_Y(), line->CY_DOT_Z(),
                              line->CY_DOT_X_DOT(), line->CY_DOT_Y_DOT(), line->CZ_DOT_X(), line->CZ_DOT_Y(), line->CZ_DOT_Z(),
                              line->CZ_DOT_X_DOT(), line->CZ_DOT_Y_DOT(), line->CZ_DOT_Z_DOT()};
        std::copy(v, v + 21, c.c.begin());
        blk.cov.push_back(c);
      }
    }
    std::sort(blk.rows.begin(), blk.rows.end(), [](const Row& a, const Row& b) { return before(a.t, b.t); });
    std::sort(blk.cov.begin(), blk.cov.end(), [](const CovLine& a, const CovLine& b) { return before(a.t, b.t); });
    blocks->push_back(std::move(blk));
  }
  return true;
}

// A fit's $OCM: the state rows and, when present, the formal covariance at each (21 values, lower triangle).
bool read_ocm_block(const RawRecord& raw, std::vector<Block>* blocks, std::string* error) {
  if (!verified(raw, [](flatbuffers::Verifier& v) { return VerifyOCMBuffer(v); }, [](flatbuffers::Verifier& v) { return VerifySizePrefixedOCMBuffer(v); })) {
    *error = "invalid $OCM record";
    return false;
  }
  const OCM* ocm = raw.prefixed ? GetSizePrefixedOCM(raw.bytes.data()) : GetOCM(raw.bytes.data());
  Block blk;
  blk.is_ocm = true;
  const Metadata* meta = ocm->METADATA();
  blk.name = meta && meta->OBJECT_NAME() ? meta->OBJECT_NAME()->str() : "";
  blk.object_id = meta && meta->INTERNATIONAL_DESIGNATOR() ? meta->INTERNATIONAL_DESIGNATOR()->str() : "";
  // The fit names a numbered object by its catalog designator (analysis/od: CATALOG_NAME is the NORAD number).
  if (meta && meta->CATALOG_NAME() && meta->CATALOG_NAME()->size() > 0) {
    const std::string c = meta->CATALOG_NAME()->str();
    char* end = nullptr;
    const unsigned long n = std::strtoul(c.c_str(), &end, 10);
    if (end && *end == '\0' && n > 0 && n <= 0xFFFFFFFFul) blk.norad = static_cast<uint32_t>(n);
  }
  blk.key = key_of(blk.norad, blk.object_id, blk.name);
  blk.frame = unpack_frame(ocm->TRAJ_REF_FRAME());
  blk.frame_name = frame_name_of(ocm->TRAJ_REF_FRAME());
  if (blk.frame_name.empty() && ocm->USER_DEFINED_PARAMETERS()) {
    for (const UserDefinedParameters* p : *ocm->USER_DEFINED_PARAMETERS()) {
      if (p->PARAM_NAME() && p->PARAM_NAME()->str() == "STATE_REFERENCE_FRAME" && p->PARAM_VALUE()) blk.frame_name = p->PARAM_VALUE()->str();
    }
  }
  blk.cov_frame = unpack_frame(ocm->COV_REF_FRAME());
  blk.cov_frame_name = frame_name_of(ocm->COV_REF_FRAME());
  if (!ocm->STATE_DATA() || ocm->STATE_VECTOR_SIZE() < 6) return true;
  const unsigned width = ocm->STATE_VECTOR_SIZE();
  const size_t rows = ocm->STATE_DATA()->size() / width;
  Instant start;
  const bool has_start = meta && parse_instant(meta->START_TIME(), &start);
  for (size_t i = 0; i < rows; ++i) {
    Row row;
    if (ocm->STATE_EPOCHS() && i < ocm->STATE_EPOCHS()->size()) {
      if (!parse_instant(ocm->STATE_EPOCHS()->Get(i), &row.t)) { *error = "an OCM state epoch is invalid"; return false; }
      row.text = ocm->STATE_EPOCHS()->Get(i)->str();
    } else if (has_start && (ocm->STATE_STEP_SIZE() > 0 || i == 0)) {
      row.t = start;
      row.t.sec += static_cast<double>(i) * ocm->STATE_STEP_SIZE();
      while (row.t.sec >= kDay) { row.t.sec -= kDay; row.t.day += 1; }
      if (i == 0 && meta->START_TIME()) row.text = meta->START_TIME()->str();
    } else {
      *error = "an OCM state row has no epoch (STATE_EPOCHS or START_TIME with STATE_STEP_SIZE)";
      return false;
    }
    for (int k = 0; k < 6; ++k) row.x[k] = ocm->STATE_DATA()->Get(i * width + k);
    blk.rows.push_back(row);
  }
  const bool plain = ocm->COV_TYPE() == nullptr || ocm->COV_TYPE()->size() == 0 || ocm->COV_TYPE()->str() == "CARTPV";
  if (ocm->COVARIANCE_DATA() && plain && ocm->COV_ORDERING() == covarianceOrdering::LTM && ocm->COV_SIZE() == 6 &&
      ocm->COVARIANCE_DATA()->size() == 21 * rows) {
    for (size_t i = 0; i < rows; ++i) {
      CovLine c;
      c.t = blk.rows[i].t;
      c.text = blk.rows[i].text;
      for (int k = 0; k < 21; ++k) c.c[k] = ocm->COVARIANCE_DATA()->Get(21 * i + k);
      blk.cov.push_back(c);
    }
  }
  blocks->push_back(std::move(blk));
  return true;
}

// ── covariance algebra ──────────────────────────────────────────────────────────────────────────────────────────

void full_from_lower(const std::array<double, 21>& lower, double out[36]) {
  for (int a = 0, t = 0; a < 6; ++a)
    for (int b = 0; b <= a; ++b, ++t) out[6 * a + b] = out[6 * b + a] = lower[t];
}
std::array<double, 21> lower_from_full(const double m[36]) {
  std::array<double, 21> out{};
  for (int a = 0, t = 0; a < 6; ++a)
    for (int b = 0; b <= a; ++b, ++t) out[t] = m[6 * a + b];
  return out;
}
bool finite_cov(const std::array<double, 21>& c) {
  for (double x : c)
    if (!std::isfinite(x)) return false;
  return true;
}

// A set's mean altitude and eccentricity place it in a model's regime; a model's age bins place an age in a cell.
struct Lookup {
  std::string status;  // empty when ok
  int regime = -1, age_index = -1;
  std::string regime_id;
  std::array<double, 21> cov{};
  double scale = NAN;  // the factor the model's covariance was multiplied by, when it has one
};
Lookup model_lookup(const Model& m, double alt_km, double ecc, double age_days) {
  Lookup out;
  const Options& o = m.sm.options;
  out.regime = regime_of(o, alt_km, ecc);
  if (out.regime < 0) { out.status = "outside-regimes"; return out; }
  out.regime_id = o.regimes[out.regime].id;
  out.age_index = age_of(o, age_days);
  if (out.age_index < 0) { out.status = "age-outside-model"; return out; }
  std::vector<double> c21;
  double k2 = 1.0;
  if (!evaluate_population(m.sm, out.regime, age_days, &c21, &k2)) {
    out.status = "no-model-for-regime";
    return out;
  }
  const auto have = populated_bins(m.sm, out.regime);
  for (size_t i = 0; i < have.size(); ++i)
    if (have[i] && m.sm.factor.count({out.regime, static_cast<int>(i)})) out.scale = k2;
  for (int k = 0; k < 21; ++k) out.cov[k] = c21[k] * k2;
  return out;
}

const Model* model_for(const Recipe& r, bool* own) {
  for (const Model& m : r.models)
    if (contains(m.sources, r.a.id)) { *own = true; return &m; }
  for (const Model& m : r.models)
    if (m.pooled) { *own = false; return &m; }
  return nullptr;
}

Label modeled_label(const Recipe& r, const Model& m, bool own, const Lookup& lk, double age_days) {
  Label l;
  l.rule = own ? 3 : 4;
  l.method = own ? "e14-s3-kc" : "e14-s3-kc-pooled";
  l.model_id = m.id;
  l.regime = lk.regime_id;
  l.age_index = lk.age_index;
  l.age_days = age_days;
  l.scale = lk.scale;
  l.window = m.window;
  l.evidence = m.evidence;
  const auto it = m.cells.find({lk.regime, lk.age_index});
  const bool measured_here = contains(m.lineages, r.a.lineage);
  l.measured_lineage = measured_here ? r.a.lineage : (m.lineages.empty() ? std::string() : m.lineages.front());
  if (it != m.cells.end()) {
    const Verdict& v = it->second;
    l.horizon = v.horizon;
    l.verdict = v.decision;
    l.mean_d2 = v.mean_d2;
    l.coverage = v.coverage;
    l.samples = v.samples;
    l.objects = v.objects;
    l.calibration = verdict_of(l, measured_here);
    if (l.calibrated()) {
      l.basis = "the cell passed the realism rule on the held-out window for " + r.a.lineage;
    } else if (measured_here) {
      l.basis = "the cell did not pass the realism rule on the held-out window for " + r.a.lineage;
    } else {
      l.basis = "not measured on " + r.a.lineage + "; the cell's numbers are the model's own lineage (" +
                (m.lineages.empty() ? std::string("unstated") : m.lineages.front()) + ")";
    }
  } else {
    l.calibration = "UNCALIBRATED";
    l.basis = "the model has no held-out verdict for this cell";
  }
  return l;
}

// ── products ────────────────────────────────────────────────────────────────────────────────────────────────────

struct OutRow {
  Instant t;
  std::string text;
  double x[6] = {};
  bool has_cov = false;
  std::array<double, 21> cov{};
  Label label;
};
struct Product {
  int rule = 0;
  std::string method, kind;  // kind: what the state is
  std::shared_ptr<RFMT> state_frame, cov_frame;
  std::string state_frame_name, cov_frame_name;
  CovAxes axes = CovAxes::Rtn;
  std::vector<OutRow> rows;
  Json notes = Json::array();
};

std::shared_ptr<RFMT> rtn_frame() {
  auto f = std::make_shared<RFMT>();
  f->NAME = "RSW";
  OrbitFrameWrapperT w;
  w.frame = OrbitFrame::RSW_INERTIAL;
  f->REFERENCE_FRAME.Set(std::move(w));
  return f;
}
std::string iso_micro(const Instant& t) {
  // YYYY-MM-DDTHH:MM:SS.ffffffZ from a unix day and seconds of day.
  int64_t day = t.day;
  int64_t micro = std::llround(t.sec * 1.0e6);
  if (micro >= 86400000000LL) { day += 1; micro -= 86400000000LL; }
  if (micro < 0) { day -= 1; micro += 86400000000LL; }
  int64_t z = day + 719468;
  const int64_t era = (z >= 0 ? z : z - 146096) / 146097;
  const int64_t doe = z - era * 146097;
  const int64_t yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
  const int64_t y = yoe + era * 400;
  const int64_t doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
  const int64_t mp = (5 * doy + 2) / 153;
  const int64_t d = doy - (153 * mp + 2) / 5 + 1;
  const int64_t m = mp < 10 ? mp + 3 : mp - 9;
  const int64_t whole = micro / 1000000LL;
  char b[48];
  std::snprintf(b, sizeof b, "%04lld-%02lld-%02lldT%02lld:%02lld:%02lld.%06lldZ", static_cast<long long>(y + (m <= 2 ? 1 : 0)),
                static_cast<long long>(m), static_cast<long long>(d), static_cast<long long>(whole / 3600),
                static_cast<long long>((whole / 60) % 60), static_cast<long long>(whole % 60), static_cast<long long>(micro % 1000000LL));
  return b;
}

// The covariance of a row in RTN axes (lower triangle): as it is, or rotated from the state's own inertial axes.
bool rtn_of(CovAxes axes, const OutRow& row, std::array<double, 21>* out) {
  if (!row.has_cov) return false;
  if (axes == CovAxes::Rtn) { *out = row.cov; return true; }
  if (axes != CovAxes::State) return false;
  double full[36], rtn[36], ax[3][3];
  full_from_lower(row.cov, full);
  axes_of(row.x, row.x + 3, ax);
  rotate6(ax, full, rtn, true);
  *out = lower_from_full(rtn);
  return true;
}

// Rule 1: the operator's covariance, as supplied, at up to max_rows of its covariance epochs.
bool operator_rule(const Recipe& r, const Block& b, Product* p) {
  if (b.cov.empty()) { p->notes.push_back({{"rule", 1}, {"reason", "the operator ephemeris carries no covariance"}}); return false; }
  p->axes = classify_axes(b.cov_frame_name, b.frame_name);
  if (p->axes == CovAxes::Unsupported) {
    p->notes.push_back({{"rule", 1}, {"reason", "covariance frame " + b.cov_frame_name + " is not RTN-family or the state's own axes"}});
    return false;
  }
  std::vector<size_t> pick;
  const size_t n = b.cov.size();
  if (n <= r.max_operator_rows) {
    for (size_t i = 0; i < n; ++i) pick.push_back(i);
  } else {
    for (size_t k = 0; k < r.max_operator_rows; ++k)
      pick.push_back(r.max_operator_rows == 1 ? 0 : static_cast<size_t>(std::llround(static_cast<double>(k) * static_cast<double>(n - 1) / static_cast<double>(r.max_operator_rows - 1))));
    pick.erase(std::unique(pick.begin(), pick.end()), pick.end());
  }
  size_t unmatched = 0;
  for (size_t i : pick) {
    const CovLine& c = b.cov[i];
    const Row* state = nullptr;
    for (const Row& row : b.rows)
      if (std::fabs(seconds_between(row.t, c.t)) <= 1e-3) { state = &row; break; }
    if (!state || !finite_cov(c.c)) { ++unmatched; continue; }
    OutRow o;
    o.t = c.t;
    o.text = c.text.empty() ? iso_micro(c.t) : c.text;
    std::copy(state->x, state->x + 6, o.x);
    o.has_cov = true;
    o.cov = c.c;
    o.label.rule = 1;
    o.label.method = "operator-supplied";
    o.label.calibration = "UNCALIBRATED";
    o.label.basis = "operator covariance as supplied; not measured against independent orbits";
    p->rows.push_back(o);
  }
  if (unmatched) p->notes.push_back({{"rule", 1}, {"reason", std::to_string(unmatched) + " covariance epoch(s) without a state at that epoch, or not finite"}});
  if (p->rows.empty()) return false;
  p->rule = 1;
  p->method = "operator-supplied";
  p->kind = "operator-ephemeris";
  p->state_frame = b.frame;
  p->state_frame_name = b.frame_name;
  p->cov_frame = b.cov_frame;
  p->cov_frame_name = b.cov_frame_name;
  return true;
}

// Rule 2: a fit's formal covariance times the realism factor measured for the source and the fit's class.
bool fit_rule(const Recipe& r, const Block& b, Product* p) {
  if (b.cov.empty()) { p->notes.push_back({{"rule", 2}, {"reason", "the fit carries no covariance"}}); return false; }
  const Realism* hit = nullptr;
  for (const Realism& s : r.realism)
    if ((contains(s.sources, r.a.id) || contains(s.sources, "*")) && !r.a.fit_class.empty() && s.cls == r.a.fit_class) { hit = &s; break; }
  if (!hit) {
    p->notes.push_back({{"rule", 2}, {"reason", "no measured realism factor for source " + r.a.id + " and fit class " + (r.a.fit_class.empty() ? std::string("(unstated)") : r.a.fit_class)}});
    return false;
  }
  p->axes = classify_axes(b.cov_frame_name, b.frame_name);
  if (p->axes == CovAxes::Unsupported) {
    p->notes.push_back({{"rule", 2}, {"reason", "covariance frame " + b.cov_frame_name + " is not RTN-family or the state's own axes"}});
    return false;
  }
  for (const CovLine& c : b.cov) {
    const Row* state = nullptr;
    for (const Row& row : b.rows)
      if (std::fabs(seconds_between(row.t, c.t)) <= 1e-3) { state = &row; break; }
    if (!state || !finite_cov(c.c)) continue;
    OutRow o;
    o.t = c.t;
    o.text = c.text.empty() ? iso_micro(c.t) : c.text;
    std::copy(state->x, state->x + 6, o.x);
    o.has_cov = true;
    for (int k = 0; k < 21; ++k) o.cov[k] = c.c[k] * hit->factor;
    o.label.rule = 2;
    o.label.method = "fit-formal-scaled";
    o.label.model_id = hit->cls;
    o.label.scale = hit->factor;
    o.label.mean_d2 = hit->mean_d2;
    o.label.coverage = hit->coverage;
    o.label.samples = hit->samples;
    o.label.objects = hit->objects;
    o.label.window = hit->window;
    o.label.evidence = hit->evidence;
    o.label.verdict = "formal covariance, before scaling";
    // The factor was measured for this source when the entry names it; an entry for every source ("*") says nothing of its lineage.
    const bool measured_here = contains(hit->sources, r.a.id);
    if (measured_here) o.label.measured_lineage = r.a.lineage;
    o.label.calibration = verdict_of(o.label, measured_here);
    o.label.basis = o.label.calibrated() ? "the covariance passed the realism rule on held-out data"
                                         : "scaled by the factor measured on held-out data; the scaled covariance has not been tested itself";
    p->rows.push_back(o);
  }
  if (p->rows.empty()) return false;
  p->rule = 2;
  p->method = "fit-formal-scaled";
  p->kind = "fit-state";
  p->state_frame = b.frame;
  p->state_frame_name = b.frame_name;
  p->cov_frame = b.cov_frame;
  p->cov_frame_name = b.cov_frame_name;
  return true;
}

// Rules 3 and 4: the model's covariance at each state row's age from its element set.
bool modeled_rule(const Recipe& r, const SetRec& s, const Block& b, Product* p) {
  bool own = false;
  const Model* m = model_for(r, &own);
  if (!m) { p->notes.push_back({{"rule", 3}, {"reason", "no model for source " + r.a.id + " and no pooled model"}}); return false; }
  if (!std::isfinite(s.alt_km)) { p->notes.push_back({{"rule", own ? 3 : 4}, {"reason", "the element set cannot be placed in a regime: " + s.unusable}}); return false; }
  for (const Row& row : b.rows) {
    const double age = seconds_between(s.epoch, row.t) / kDay;
    if (age < -1e-6) { p->notes.push_back({{"rule", own ? 3 : 4}, {"reason", "a state row before the element set's epoch"}}); continue; }
    const Lookup lk = model_lookup(*m, s.alt_km, s.ecc, std::max(0.0, age));
    if (!lk.status.empty()) {
      p->notes.push_back({{"rule", own ? 3 : 4}, {"row", row.text}, {"ageDays", age}, {"reason", lk.status}});
      continue;
    }
    OutRow o;
    o.t = row.t;
    o.text = row.text.empty() ? iso_micro(row.t) : row.text;
    std::copy(row.x, row.x + 6, o.x);
    o.has_cov = true;
    o.cov = lk.cov;
    o.label = modeled_label(r, *m, own, lk, age);
    p->rows.push_back(o);
  }
  if (p->rows.empty()) return false;
  p->rule = own ? 3 : 4;
  p->method = own ? "e14-s3-kc" : "e14-s3-kc-pooled";
  p->kind = "sgp4-epoch-state";
  p->state_frame = b.frame;
  p->state_frame_name = b.frame_name;
  p->cov_frame = rtn_frame();
  p->cov_frame_name = "RSW";
  p->axes = CovAxes::Rtn;
  return true;
}

// ── the records ─────────────────────────────────────────────────────────────────────────────────────────────────

Json rows_labels(const Product& p) {
  Json out = Json::array();
  for (const OutRow& row : p.rows) {
    Json l = label_json(row.label);
    l["epoch"] = row.text;
    out.push_back(l);
  }
  return out;
}
bool all_calibrated(const Product& p) {
  if (p.rows.empty()) return false;
  for (const OutRow& row : p.rows)
    if (!row.label.calibrated()) return false;
  return true;
}
// The source a record names, as the report states it.
Json source_json(const Attribution& a) {
  return {{"id", a.id}, {"kind", a.kind}, {"lineage", a.lineage}, {"originator", a.originator}, {"provider", a.provider},
          {"licence", {{"class", a.licence_class}, {"id", a.licence_id}}}};
}

// PROVENANCE (PVN): the source, the provider that published it, the software that made the record, the source's terms.
std::unique_ptr<PVNT> provenance_of(const Attribution& a, const std::string& producer) {
  auto p = std::make_unique<PVNT>();
  p->SOURCE_ID = a.id;
  p->SOURCE_KIND = a.source_kind;
  p->ORIGINATOR = a.originator;
  p->PROVIDER_ID = a.provider;
  p->PRODUCER = producer;
  p->LICENSE_CLASS = a.licence;
  p->LICENSE_ID = a.licence_id;
  p->LINEAGE = a.lineage;
  return p;
}

// The window as an ISO 8601 interval: the model file writes start..end, the CVR start/end.
std::string interval_of(std::string window) {
  const size_t at = window.find("..");
  if (at != std::string::npos && at > 0 && at + 2 < window.size()) window.replace(at, 2, "/");
  return window;
}

// One row's label as a CVR: the rule, the model or factor it came from, the cell and the numbers of its test, the verdict.
std::unique_ptr<CVRT> realism_of(const Label& l) {
  auto c = std::make_unique<CVRT>();
  c->RULE = static_cast<covarianceRule>(l.rule);  // 1 to 4: Operator, ScaledFit, SourceModel, PooledModel
  c->MODEL_ID = l.model_id;
  c->REGIME = l.regime;
  c->AGE_DAYS = l.age_days;
  c->HORIZON_DAYS = l.horizon;
  c->MEASURED_LINEAGE = l.measured_lineage;
  c->TEST_WINDOW = interval_of(l.window);
  c->MEAN_D2_OVER_3 = l.mean_d2;
  c->COVERAGE_95 = l.coverage;
  c->SAMPLES = static_cast<uint32_t>(std::min<uint64_t>(l.samples, UINT32_MAX));
  c->OBJECTS = static_cast<uint32_t>(std::min<uint64_t>(l.objects, UINT32_MAX));
  c->SCALE_FACTOR = l.scale;
  c->CALIBRATION = l.calibrated() ? covarianceCalibration::Calibrated : covarianceCalibration::Uncalibrated;
  c->EVIDENCE = l.evidence;
  return c;
}

std::vector<uint8_t> build_ocm(const Recipe& r, const std::string& key, const std::string& name, const std::string& object_id,
                               uint32_t norad, const Product& p) {
  auto ocm = std::make_unique<OCMT>();
  ocm->HEADER = std::make_unique<HeaderT>();
  ocm->HEADER->CCSDS_OCM_VERS = "3.0";
  ocm->HEADER->CREATION_DATE = r.created;
  ocm->HEADER->ORIGINATOR = r.producer;  // the message's creator; the source's originator is PROVENANCE.ORIGINATOR
  ocm->HEADER->MESSAGE_ID = r.a.id + "/" + key + "/" + p.rows.front().text + "/" + p.method;
  ocm->METADATA = std::make_unique<MetadataT>();
  MetadataT& meta = *ocm->METADATA;
  meta.OBJECT_NAME = name;
  meta.INTERNATIONAL_DESIGNATOR = object_id;
  if (norad > 0) {
    meta.CATALOG_NAME = "NORAD";
    meta.OBJECT_DESIGNATOR = std::to_string(norad);
  } else {
    meta.CATALOG_NAME = r.a.id;
    meta.OBJECT_DESIGNATOR = key;
  }
  meta.TECH_ORG = r.producer;
  meta.TIME_SYSTEM = "UTC";
  meta.EPOCH_TZERO = p.rows.front().text;
  meta.START_TIME = p.rows.front().text;
  meta.STOP_TIME = p.rows.back().text;
  ocm->TRAJ_TYPE = trajectoryType::CARTESIAN_PV;
  ocm->TRAJ_TYPE_DESCRIPTION = p.kind;
  ocm->STATE_VECTOR_SIZE = 6;
  ocm->CENTER_NAME = "EARTH";
  if (p.state_frame) ocm->TRAJ_REF_FRAME = std::make_unique<RFMT>(*p.state_frame);
  if (p.cov_frame) ocm->COV_REF_FRAME = std::make_unique<RFMT>(*p.cov_frame);
  for (const OutRow& row : p.rows) {
    ocm->STATE_EPOCHS.push_back(row.text);
    for (int k = 0; k < 6; ++k) ocm->STATE_DATA.push_back(row.x[k]);
    for (int k = 0; k < 21; ++k) ocm->COVARIANCE_DATA.push_back(row.has_cov ? row.cov[k] : NAN);
    ocm->COV_REALISM.push_back(realism_of(row.label));
  }
  ocm->COV_ORDERING = covarianceOrdering::LTM;
  ocm->COV_SIZE = 6;
  ocm->COV_UNITS = {"km**2", "km**2", "km**2", "km**2/s**2", "km**2/s**2", "km**2/s**2"};
  // Calibrated only when every row's CVR is; the evidence is the first row's (a product's rows share their model's).
  ocm->COV_CALIBRATION = all_calibrated(p) ? covarianceCalibration::Calibrated : covarianceCalibration::Uncalibrated;
  ocm->COV_CALIBRATION_REFERENCE = p.rows.front().label.evidence;
  // Where the state came from and how the covariance was made.
  ocm->ORBIT_DETERMINATION = std::make_unique<OrbitDeterminationT>();
  ocm->ORBIT_DETERMINATION->OD_ID = r.a.id + "/" + key;
  ocm->ORBIT_DETERMINATION->OD_METHOD = p.kind;
  ocm->ORBIT_DETERMINATION->OD_ALGORITHM = p.method;
  ocm->ORBIT_DETERMINATION->OD_COV_REDUCTION = p.method;
  ocm->PROVENANCE = provenance_of(r.a, r.producer);
  flatbuffers::FlatBufferBuilder fbb(2048);
  FinishSizePrefixedOCMBuffer(fbb, CreateOCM(fbb, ocm.get()));
  return std::vector<uint8_t>(fbb.GetBufferPointer(), fbb.GetBufferPointer() + fbb.GetSize());
}

// The element set as published, with the covariance of one of the product's rows (in RTN axes) and that row's CVR. The
// message's creator is the producer; the source is PROVENANCE. A set with no covariance carries no CVR, and the report says why.
std::vector<uint8_t> build_omm(const Recipe& r, const SetRec& s, const Product* p, size_t row, const std::array<double, 21>* rtn) {
  std::unique_ptr<OMMT> omm((s.prefixed ? GetSizePrefixedOMM(s.bytes.data()) : GetOMM(s.bytes.data()))->UnPack());
  omm->ORIGINATOR = r.producer;
  omm->PROVENANCE = provenance_of(r.a, r.producer);
  if (p && rtn) {
    omm->COVARIANCE.assign(rtn->begin(), rtn->end());
    omm->COV_REFERENCE_FRAME = std::make_unique<RFMT>(*rtn_frame());
    omm->COV_REALISM = realism_of(p->rows[row].label);
  }
  flatbuffers::FlatBufferBuilder fbb(1024);
  FinishSizePrefixedOMMBuffer(fbb, CreateOMM(fbb, omm.get()));
  return std::vector<uint8_t>(fbb.GetBufferPointer(), fbb.GetBufferPointer() + fbb.GetSize());
}

}  // namespace sp

extern "C" int attach_covariance() {
  using namespace sp;
  Recipe recipe;
  std::string error;
  Json recipe_json = ermb::recipe_from_config("attach", &error);
  if (!error.empty()) return fail("invalid-recipe", error);
  // The models: $ERM MODEL records on the models port (one record each, size-prefixed, any number of frames).
  if (!recipe_json.contains("models")) recipe_json["models"] = Json::array();
  for (uint32_t i = 0; i < plugin_get_input_count(); ++i) {
    const plugin_input_frame_t* f = plugin_get_input_frame(i);
    if (!f || !f->port_id || std::strcmp(f->port_id, "models") != 0) continue;
    for (size_t at = 0; at < f->payload_length;) {
      const uint8_t* p = f->payload + at;
      size_t len = f->payload_length - at;
      if (len >= 8 && flatbuffers::BufferHasIdentifier(p, ERMIdentifier(), true)) len = std::min(len, size_t(4) + flatbuffers::ReadScalar<uint32_t>(p));
      const std::unique_ptr<ERMT> e = ermb::read_erm(p, len);
      if (!e || !e->MODEL) return fail("invalid-models", "models carries $ERM MODEL records" + (e ? std::string() : ": " + ermb::last_error));
      recipe_json["models"].push_back(ermb::model_out(*e->MODEL));
      at += len;
    }
  }
  error = read_recipe(recipe_json, &recipe);
  if (!error.empty()) return fail("invalid-recipe", error);

  std::vector<RawRecord> raw_sets, raw_states, raw_operator, raw_fits;
  if (!port_records("elements", "$OMM", &raw_sets, &error)) return fail("invalid-elements", error);
  if (!port_records("states", "$OEM", &raw_states, &error)) return fail("invalid-states", error);
  if (!port_records("operator", "$OEM", &raw_operator, &error)) return fail("invalid-operator", error);
  if (!port_records("fit", "$OCM", &raw_fits, &error)) return fail("invalid-fit", error);

  Json refused = Json::array();
  std::vector<SetRec> sets;
  if (!load_sets(raw_sets, &sets, &refused, &error)) return fail("invalid-elements", error);

  std::vector<Block> states, operators;
  for (const RawRecord& rec : raw_states) {
    if (rec.ident != "$OEM") return fail("invalid-states", "states carries $OEM records.");
    if (!read_oem_blocks(rec, &states, &error)) return fail("invalid-states", error);
  }
  for (const RawRecord& rec : raw_operator) {
    if (rec.ident != "$OEM") return fail("invalid-operator", "operator carries $OEM records.");
    if (!read_oem_blocks(rec, &operators, &error)) return fail("invalid-operator", error);
  }
  // A fit is considered after an operator ephemeris of the same object: rule 1 comes before rule 2.
  for (const RawRecord& rec : raw_fits) {
    if (rec.ident != "$OCM") return fail("invalid-fit", "fit carries $OCM records.");
    if (!read_ocm_block(rec, &operators, &error)) return fail("invalid-fit", error);
  }

  // Which sets give outputs: the newest of each object, or all.
  std::vector<const SetRec*> chosen;
  for (size_t i = 0; i < sets.size(); ++i)
    if (!recipe.latest_only || i + 1 == sets.size() || sets[i + 1].key != sets[i].key) chosen.push_back(&sets[i]);

  // The block of states derived from a set: the object's, starting at the set's epoch.
  auto states_of = [&](const SetRec& set) {
    for (size_t i = 0; i < states.size(); ++i)
      if (states[i].key == set.key && !states[i].rows.empty() && std::fabs(seconds_between(set.epoch, states[i].rows.front().t)) <= 1e-3) return i;
    return states.size();
  };
  std::set<size_t> matched_states, used_operator;
  uint64_t states_of_older_sets = 0;
  for (const SetRec& set : sets) {
    const size_t i = states_of(set);
    if (i < states.size()) matched_states.insert(i);
  }

  std::vector<uint8_t> ocm_stream, omm_stream;
  Json objects = Json::array();
  uint64_t by_rule[5] = {}, calibrated_rows = 0, uncalibrated_rows = 0, uncovered = 0;
  for (const SetRec* s : chosen) {
    Json entry = {{"object", s->key}, {"epoch", s->epoch_text}, {"theory", EnumNamemeanElementSource(s->theory)}};
    Product product;
    bool have = false;
    const size_t state_index = states_of(*s);
    // Rules 1 and 2 use the operator's own data, which serves any set of the object: an operator ephemeris first
    // (rule 1), then a fit (rule 2).
    for (int pass = 0; pass < 2 && !have; ++pass) {
      for (size_t i = 0; i < operators.size() && !have; ++i) {
        if (operators[i].key != s->key || operators[i].is_ocm != (pass == 1)) continue;
        used_operator.insert(i);
        have = pass == 1 ? fit_rule(recipe, operators[i], &product) : operator_rule(recipe, operators[i], &product);
      }
    }
    // Rules 3 and 4 need an SGP4 set placed in a regime and its states.
    if (!have) {
      if (!s->unusable.empty()) product.notes.push_back({{"rule", 3}, {"reason", s->unusable}});
      else if (state_index >= states.size()) product.notes.push_back({{"rule", 3}, {"reason", "no states derived from this element set"}});
      else have = modeled_rule(recipe, *s, states[state_index], &product);
    }

    if (have) {
      // The OMM carries the covariance of the row nearest the element set's epoch, in RTN axes.
      size_t nearest = 0;
      for (size_t i = 1; i < product.rows.size(); ++i)
        if (std::fabs(seconds_between(s->epoch, product.rows[i].t)) < std::fabs(seconds_between(s->epoch, product.rows[nearest].t))) nearest = i;
      std::array<double, 21> rtn{};
      const bool have_rtn = rtn_of(product.axes, product.rows[nearest], &rtn);
      const std::vector<uint8_t> omm = build_omm(recipe, *s, &product, nearest, have_rtn ? &rtn : nullptr);
      omm_stream.insert(omm_stream.end(), omm.begin(), omm.end());
      entry["ommSha256"] = sha256_hex(omm);
      const std::vector<uint8_t> ocm = build_ocm(recipe, s->key, s->name, s->object_id, s->norad, product);
      ocm_stream.insert(ocm_stream.end(), ocm.begin(), ocm.end());
      entry["ocmSha256"] = sha256_hex(ocm);
      ++by_rule[product.rule];
      for (const OutRow& row : product.rows) (row.label.calibrated() ? calibrated_rows : uncalibrated_rows)++;
      entry["rule"] = product.rule;
      entry["method"] = product.method;
      entry["product"] = product.kind;
      entry["calibrated"] = all_calibrated(product);
      entry["ommCovariance"] = have_rtn ? "rtn" : "unavailable";
      entry["rows"] = rows_labels(product);
    } else {
      ++uncovered;
      const std::vector<uint8_t> omm = build_omm(recipe, *s, nullptr, 0, nullptr);
      omm_stream.insert(omm_stream.end(), omm.begin(), omm.end());
      entry["ommSha256"] = sha256_hex(omm);
      entry["rule"] = nullptr;
    }
    entry["notes"] = product.notes;
    entry["licence"] = {{"class", recipe.a.licence_class}, {"id", recipe.a.licence_id}};
    objects.push_back(entry);
  }
  for (size_t i : matched_states) {
    bool chosen_set = false;
    for (const SetRec* s : chosen)
      if (states_of(*s) == i) chosen_set = true;
    if (!chosen_set) ++states_of_older_sets;
  }

  Json unmatched = {{"states", Json::array()}, {"operator", Json::array()}};
  for (size_t i = 0; i < states.size(); ++i)
    if (!matched_states.count(i)) unmatched["states"].push_back({{"object", states[i].key}, {"first", states[i].rows.empty() ? Json("") : Json(states[i].rows.front().text)}});
  for (size_t i = 0; i < operators.size(); ++i)
    if (!used_operator.count(i)) unmatched["operator"].push_back({{"object", operators[i].key}});

  const Json report = {{"version", 1},
                       {"source", source_json(recipe.a)},
                       {"counts", {{"elementSets", sets.size()}, {"objects", objects.size()}, {"rule1", by_rule[1]}, {"rule2", by_rule[2]},
                                   {"rule3", by_rule[3]}, {"rule4", by_rule[4]}, {"withoutCovariance", uncovered},
                                   {"calibratedRows", calibrated_rows}, {"uncalibratedRows", uncalibrated_rows},
                                   {"statesOfOlderSets", states_of_older_sets}}},
                       {"refusedElementSets", refused},
                       {"unmatched", unmatched},
                       {"objects", objects}};
  if (!ocm_stream.empty() &&
      plugin_push_output_ex("ocm", "OCM.fbs", "$OCM", PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, "OCM", 0, 0, ocm_stream.data(), static_cast<uint32_t>(ocm_stream.size())) < 0)
    return 1;
  if (!omm_stream.empty() &&
      plugin_push_output_ex("omm", "OMM.fbs", "$OMM", PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, "OMM", 0, 0, omm_stream.data(), static_cast<uint32_t>(omm_stream.size())) < 0)
    return 1;
  return emit("report", report);
}

extern "C" int attribute_maneuvers() {
  using namespace sp;
  Attribution a;
  std::string error;
  const Json recipe = ermb::recipe_from_config("attribute", &error);
  if (!error.empty()) return fail("invalid-recipe", error);
  error = read_attribution(recipe, &a);
  if (!error.empty()) return fail("invalid-recipe", error);
  std::string producer = json_string(recipe, "producer");
  if (producer.empty()) producer = kDefaultProducer;
  std::vector<RawRecord> raw;
  if (!port_records("maneuvers", "$MNV", &raw, &error)) return fail("invalid-maneuvers", error);
  std::vector<uint8_t> stream;
  for (const RawRecord& rec : raw) {
    if (rec.ident != "$MNV" || !verified(rec, [](flatbuffers::Verifier& v) { return VerifyMNVBuffer(v); }, [](flatbuffers::Verifier& v) { return VerifySizePrefixedMNVBuffer(v); }))
      return fail("invalid-maneuvers", "maneuvers carries $MNV records.");
    std::unique_ptr<MNVT> mnv((rec.prefixed ? GetSizePrefixedMNV(rec.bytes.data()) : GetMNV(rec.bytes.data()))->UnPack());
    // The software that made the maneuver (the detector) stays its PRODUCER; the source is the recipe's.
    const std::string made_by = mnv->PROVENANCE ? mnv->PROVENANCE->PRODUCER : std::string();
    mnv->PROVENANCE = provenance_of(a, made_by.empty() ? producer : made_by);
    flatbuffers::FlatBufferBuilder fbb(1024);
    FinishSizePrefixedMNVBuffer(fbb, CreateMNV(fbb, mnv.get()));
    stream.insert(stream.end(), fbb.GetBufferPointer(), fbb.GetBufferPointer() + fbb.GetSize());
  }
  if (!stream.empty() &&
      plugin_push_output_ex("maneuvers", "MNV.fbs", "$MNV", PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, "MNV", 0, 0, stream.data(), static_cast<uint32_t>(stream.size())) < 0)
    return 1;
  return emit("report", {{"version", 1}, {"maneuvers", raw.size()}, {"source", source_json(a)}, {"producer", producer}});
}
