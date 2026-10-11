// Covariance for every object, by the rule order of the catalog pipeline, written into SDS records. Built in one
// translation unit after gp_error_model.cpp and covariance_realism.cpp, whose element loading, regime rule,
// age bins, model reading, interpolation and RTN algebra it uses.
//
// attach_covariance
//   elements  $OMM   the element sets of one source, SGP4 (or SGP4-XP, passed through)
//   states    $OEM   each set's states at its epoch plus ages (analysis/epoch-state derive_omm), GCRF
//   operator  $OEM   optional: the operator's ephemeris with its covariance (COVARIANCE_MATRIX_LINES), or
//             $OCM   a fit's state and formal covariance (COVARIANCE_DATA)
//   recipe    JSON   the source's attribution, the models and their held-out verdicts, the measured realism factors
//   -> ocm    $OCM   state and covariance per object, with the covariance's label
//      omm    $OMM   the element set with its COVARIANCE and the label in COMMENT
//      report JSON   per object: the rule that applied, why the earlier rules did not, every row's cell and verdict
//
// The first rule that applies gives the covariance of an object's product:
//   1  the operator's covariance, as supplied (a state block with covariance lines)
//   2  the formal covariance of a fit, times the realism factor measured for that source and class (E6: laser-range
//      fits measured 16-21 times too small)
//   3  the source's own model of its element sets' error by regime and age (E14 S3-KC)
//   4  the model pooled over all sources, for a source with no model of its own
// Rules 3 and 4 cover every object that has an SGP4 element set in a regime the model covers.
// A covariance is labeled CALIBRATED only where the model's cell was REALISTIC on E14's held-out window for the
// lineage the source belongs to (mean d^2/3 in [0.8, 1.25], 95 % coverage in [0.93, 0.97]); everywhere else it is
// UNCALIBRATED with the cell's measured mean d^2/3 and coverage, or without them for a source never measured.
//
// attribute_maneuvers
//   maneuvers $MNV, recipe JSON -> maneuvers $MNV: every record names its source in TAGS (the schema has no
//   ORIGINATOR), and the report counts them.
//
// Errors are returned, not thrown: the module is built without exceptions.

namespace sp {

using Json = nlohmann::json;
using namespace covreal;

constexpr size_t kMaxRecordsPerPort = 400000;
constexpr double kDay = 86400.0;

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
std::string stat(double x) {
  if (!std::isfinite(x)) return "n/a";
  char b[40];
  std::snprintf(b, sizeof b, std::fabs(x) < 1000 ? "%.3f" : "%.3g", x);
  return b;
}
std::string number_text(double x) {
  char b[40];
  std::snprintf(b, sizeof b, "%g", x);
  return b;
}
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
};
struct Verdict {
  bool realistic = false;
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
  bool scaled_realistic = false;  // the scaled covariance itself passed a held-out test
};
struct Recipe {
  Attribution a;
  std::string producer = "SDN catalog pipeline", created;
  bool latest_only = true;
  size_t max_operator_rows = 8;
  std::string operator_calibration = "UNCALIBRATED", operator_evidence = "operator covariance as supplied; not measured against independent orbits";
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
  if (a->kind != "element-set" && a->kind != "ephemeris" && a->kind != "observation") return "recipe.source.kind is element-set, ephemeris or observation.";
  if (a->originator.empty()) return "recipe.source.originator is required: every record names its source.";
  if (a->provider.empty()) return "recipe.source.provider is required: every record names its publishing provider.";
  if (a->licence_class.empty()) return "recipe.source.licence.class is required: every record carries its source's licence class.";
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
      v.realistic = json_string(c, "calibration") == "CALIBRATED";
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
  if (j.contains("operator") && j["operator"].is_object()) {
    const std::string c = json_string(j["operator"], "calibration");
    if (!c.empty()) {
      if (c != "CALIBRATED" && c != "UNCALIBRATED") return "operator.calibration is CALIBRATED or UNCALIBRATED.";
      r->operator_calibration = c;
    }
    if (!json_string(j["operator"], "evidence").empty()) r->operator_evidence = json_string(j["operator"], "evidence");
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
      s.scaled_realistic = x.contains("scaledDecision") && x["scaledDecision"].is_string() && x["scaledDecision"].get<std::string>() == "REALISTIC";
      r->realism.push_back(std::move(s));
    }
  }
  return {};
}

// ── labels ──────────────────────────────────────────────────────────────────────────────────────────────────────

struct Label {
  int rule = 0;
  std::string method, model_id, regime, verdict, calibration, basis, window, evidence;
  int age_index = -1;
  double age_days = NAN, horizon = NAN, mean_d2 = NAN, coverage = NAN, scale = NAN;
  uint64_t samples = 0, objects = 0;
  bool calibrated() const { return calibration == "CALIBRATED"; }
};

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
  return j;
}

// One line, the evidence of a row's label as the experiments write it.
std::string reference_text(const Label& l) {
  std::string t;
  if (!l.evidence.empty()) t += l.evidence + (l.window.empty() ? "" : " " + l.window) + ": ";
  if (!l.regime.empty()) t += l.regime + " " + number_text(std::isfinite(l.horizon) ? l.horizon : l.age_days) + " d, ";
  if (std::isfinite(l.mean_d2)) {
    t += "mean d2/3 " + stat(l.mean_d2) + ", 95 % coverage " + stat(l.coverage) + " (" + std::to_string(l.samples) + " samples, " +
         std::to_string(l.objects) + " objects)";
  }
  if (std::isfinite(l.scale)) t += "; formal covariance times " + stat(l.scale);
  if (!l.calibrated() && !l.verdict.empty()) t += "; " + l.verdict;
  if (!l.basis.empty()) t += (t.empty() ? "" : "; ") + l.basis;
  return t;
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
};
Lookup model_lookup(const Model& m, double alt_km, double ecc, double age_days) {
  Lookup out;
  const Options& o = m.sm.options;
  out.regime = regime_of(o, alt_km, ecc);
  if (out.regime < 0) { out.status = "outside-regimes"; return out; }
  out.regime_id = o.regimes[out.regime].id;
  out.age_index = age_of(o, age_days);
  if (out.age_index < 0) { out.status = "age-outside-model"; return out; }
  std::vector<bool> have(o.ages.size()), have_factor(o.ages.size());
  bool any = false;
  for (size_t i = 0; i < o.ages.size(); ++i) {
    const auto key = std::make_pair(out.regime, static_cast<int>(i));
    const auto c = m.sm.cov.find(key);
    const auto n = m.sm.n.find(key);
    have[i] = c != m.sm.cov.end() && n != m.sm.n.end() && n->second >= m.sm.minimum_bin_samples;
    have_factor[i] = have[i] && m.sm.factor.count(key);
    any = any || have[i];
  }
  if (!any) { out.status = "no-model-for-regime"; return out; }
  std::vector<double> c21, factor;
  if (!interpolate_bins(o.ages, have, age_days, [&](int i, size_t k) { return m.sm.cov.find({out.regime, i})->second[k]; }, 21, &c21)) {
    out.status = "no-model-for-regime";
    return out;
  }
  double k2 = 1.0;
  if (std::any_of(have_factor.begin(), have_factor.end(), [](bool b) { return b; }) &&
      interpolate_bins(o.ages, have_factor, age_days, [&](int i, size_t) { return m.sm.factor.find({out.regime, i})->second; }, 1, &factor))
    k2 = factor[0];
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
  l.window = m.window;
  l.evidence = m.evidence;
  const auto it = m.cells.find({lk.regime, lk.age_index});
  const bool measured_here = contains(m.lineages, r.a.lineage);
  if (it != m.cells.end()) {
    const Verdict& v = it->second;
    l.horizon = v.horizon;
    l.verdict = v.decision;
    l.mean_d2 = v.mean_d2;
    l.coverage = v.coverage;
    l.samples = v.samples;
    l.objects = v.objects;
    if (measured_here && v.realistic) {
      l.calibration = "CALIBRATED";
      l.basis = "the cell passed the realism rule on the held-out window for " + r.a.lineage;
    } else if (measured_here) {
      l.calibration = "UNCALIBRATED";
      l.basis = "the cell did not pass the realism rule on the held-out window for " + r.a.lineage;
    } else {
      l.calibration = "UNCALIBRATED";
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
    o.label.calibration = r.operator_calibration;
    o.label.basis = r.operator_evidence;
    o.label.evidence = r.operator_evidence;
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
    o.label.scale = hit->factor;
    o.label.mean_d2 = hit->mean_d2;
    o.label.coverage = hit->coverage;
    o.label.samples = hit->samples;
    o.label.objects = hit->objects;
    o.label.window = hit->window;
    o.label.evidence = hit->evidence;
    o.label.verdict = "formal covariance, before scaling";
    o.label.calibration = hit->scaled_realistic ? "CALIBRATED" : "UNCALIBRATED";
    o.label.basis = hit->scaled_realistic ? "the scaled covariance passed the realism rule on held-out data"
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
std::string param(const Attribution& a, const Recipe& r, const char* name) {
  const std::string n = name;
  if (n == "SOURCE_ID") return a.id;
  if (n == "SOURCE_KIND") return a.kind;
  if (n == "SOURCE_ORIGINATOR") return a.originator;
  if (n == "SOURCE_PROVIDER") return a.provider;
  if (n == "SOURCE_LINEAGE") return a.lineage;
  if (n == "LICENCE_CLASS") return a.licence_class;
  if (n == "LICENCE_ID") return a.licence_id;
  return r.producer;
}
void add_param(OCMT* ocm, const std::string& name, const std::string& value) {
  auto p = std::make_unique<UserDefinedParametersT>();
  p->PARAM_NAME = name;
  p->PARAM_VALUE = value;
  ocm->USER_DEFINED_PARAMETERS.push_back(std::move(p));
}

std::vector<uint8_t> build_ocm(const Recipe& r, const std::string& key, const std::string& name, const std::string& object_id,
                               uint32_t norad, const Product& p) {
  auto ocm = std::make_unique<OCMT>();
  ocm->HEADER = std::make_unique<HeaderT>();
  ocm->HEADER->CCSDS_OCM_VERS = "3.0";
  ocm->HEADER->CREATION_DATE = r.created;
  ocm->HEADER->ORIGINATOR = r.a.originator;
  ocm->HEADER->MESSAGE_ID = r.a.id + "/" + key + "/" + p.rows.front().text + "/" + p.method;
  ocm->HEADER->COMMENT.push_back("State and covariance of " + key + " from " + r.a.id + ": " + p.kind + "; covariance by rule " +
                                 std::to_string(p.rule) + " (" + p.method + "); " + (all_calibrated(p) ? "CALIBRATED" : "UNCALIBRATED") + ".");
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
  }
  ocm->COV_ORDERING = covarianceOrdering::LTM;
  ocm->COV_SIZE = 6;
  ocm->COV_UNITS = {"km**2", "km**2", "km**2", "km**2/s**2", "km**2/s**2", "km**2/s**2"};
  ocm->COV_CALIBRATION = all_calibrated(p) ? covarianceCalibration::Calibrated : covarianceCalibration::Uncalibrated;
  std::string reference = reference_text(p.rows.front().label);
  if (p.rows.size() > 1) reference += " [row 1 of " + std::to_string(p.rows.size()) + "; every row's label is in COV_LABELS]";
  ocm->COV_CALIBRATION_REFERENCE = reference;
  // Where the state came from and how the covariance was made.
  ocm->ORBIT_DETERMINATION = std::make_unique<OrbitDeterminationT>();
  ocm->ORBIT_DETERMINATION->OD_ID = r.a.id + "/" + key;
  ocm->ORBIT_DETERMINATION->OD_METHOD = p.kind;
  ocm->ORBIT_DETERMINATION->OD_ALGORITHM = p.method;
  ocm->ORBIT_DETERMINATION->OD_COV_REDUCTION = p.method;
  add_param(ocm.get(), "SOURCE_ID", r.a.id);
  add_param(ocm.get(), "SOURCE_KIND", r.a.kind);
  add_param(ocm.get(), "SOURCE_ORIGINATOR", r.a.originator);
  add_param(ocm.get(), "SOURCE_PROVIDER", r.a.provider);
  add_param(ocm.get(), "SOURCE_LINEAGE", r.a.lineage);
  add_param(ocm.get(), "LICENCE_CLASS", r.a.licence_class);
  if (!r.a.licence_id.empty()) add_param(ocm.get(), "LICENCE_ID", r.a.licence_id);
  add_param(ocm.get(), "PRODUCER", r.producer);
  add_param(ocm.get(), "PRODUCT", p.kind);
  add_param(ocm.get(), "COV_RULE", std::to_string(p.rule));
  add_param(ocm.get(), "COV_METHOD", p.method);
  add_param(ocm.get(), "COV_FRAME", p.cov_frame_name.empty() ? p.state_frame_name : p.cov_frame_name);
  add_param(ocm.get(), "COV_LABELS", rows_labels(p).dump());
  flatbuffers::FlatBufferBuilder fbb(2048);
  FinishSizePrefixedOCMBuffer(fbb, CreateOCM(fbb, ocm.get()));
  return std::vector<uint8_t>(fbb.GetBufferPointer(), fbb.GetBufferPointer() + fbb.GetSize());
}

// The element set as published, with the covariance of one of the product's rows (in RTN axes) and the label in COMMENT.
std::vector<uint8_t> build_omm(const Recipe& r, const SetRec& s, const Product* p, size_t row, const std::array<double, 21>* rtn,
                               const std::string& why) {
  std::unique_ptr<OMMT> omm((s.prefixed ? GetSizePrefixedOMM(s.bytes.data()) : GetOMM(s.bytes.data()))->UnPack());
  omm->ORIGINATOR = r.a.originator;
  std::string note = "SDN covariance: ";
  if (p && rtn) {
    const Label& label = p->rows[row].label;
    note += "rule " + std::to_string(p->rule) + " " + p->method + "; " + (label.calibrated() ? "CALIBRATED" : "UNCALIBRATED") + "; " + reference_text(label);
    omm->COVARIANCE.assign(rtn->begin(), rtn->end());
    omm->COV_REFERENCE_FRAME = std::make_unique<RFMT>(*rtn_frame());
  } else {
    note += "unavailable (" + why + ")";
  }
  note += " | source " + r.a.id + ", originator " + r.a.originator + ", provider " + r.a.provider + ", licence " + r.a.licence_class;
  omm->COMMENT = omm->COMMENT.empty() ? note : omm->COMMENT + " | " + note;
  flatbuffers::FlatBufferBuilder fbb(1024);
  FinishSizePrefixedOMMBuffer(fbb, CreateOMM(fbb, omm.get()));
  return std::vector<uint8_t>(fbb.GetBufferPointer(), fbb.GetBufferPointer() + fbb.GetSize());
}

}  // namespace sp

extern "C" int attach_covariance() {
  using namespace sp;
  Recipe recipe;
  std::string error = read_recipe(json_input("recipe"), &recipe);
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
      const std::vector<uint8_t> omm = build_omm(recipe, *s, &product, nearest, have_rtn ? &rtn : nullptr, "the covariance's axes cannot be rotated to RTN");
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
      const std::string why = product.notes.empty() ? std::string("no rule applied") : product.notes.back().value("reason", std::string("no rule applied"));
      const std::vector<uint8_t> omm = build_omm(recipe, *s, nullptr, 0, nullptr, why);
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
                       {"source", {{"id", recipe.a.id}, {"kind", recipe.a.kind}, {"lineage", recipe.a.lineage}, {"originator", recipe.a.originator},
                                   {"provider", recipe.a.provider}, {"licence", {{"class", recipe.a.licence_class}, {"id", recipe.a.licence_id}}}}},
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
  const Json recipe = json_input("recipe");
  if (recipe.is_discarded()) return fail("invalid-recipe", "recipe must be JSON.");
  std::string error = read_attribution(recipe, &a);
  if (!error.empty()) return fail("invalid-recipe", error);
  std::vector<RawRecord> raw;
  if (!port_records("maneuvers", "$MNV", &raw, &error)) return fail("invalid-maneuvers", error);
  std::vector<std::string> tags = {"originator:" + a.originator, "source:" + a.id, "provider:" + a.provider, "licence:" + a.licence_class};
  if (!a.licence_id.empty()) tags.push_back("licence-id:" + a.licence_id);
  if (a.lineage != a.id) tags.push_back("lineage:" + a.lineage);
  const std::string producer = json_string(recipe, "producer");
  if (!producer.empty()) tags.push_back("producer:" + producer);
  std::vector<uint8_t> stream;
  for (const RawRecord& rec : raw) {
    if (rec.ident != "$MNV" || !verified(rec, [](flatbuffers::Verifier& v) { return VerifyMNVBuffer(v); }, [](flatbuffers::Verifier& v) { return VerifySizePrefixedMNVBuffer(v); }))
      return fail("invalid-maneuvers", "maneuvers carries $MNV records.");
    std::unique_ptr<MNVT> mnv((rec.prefixed ? GetSizePrefixedMNV(rec.bytes.data()) : GetMNV(rec.bytes.data()))->UnPack());
    for (const std::string& tag : tags)
      if (!contains(mnv->TAGS, tag)) mnv->TAGS.push_back(tag);
    flatbuffers::FlatBufferBuilder fbb(1024);
    FinishSizePrefixedMNVBuffer(fbb, CreateMNV(fbb, mnv.get()));
    stream.insert(stream.end(), fbb.GetBufferPointer(), fbb.GetBufferPointer() + fbb.GetSize());
  }
  if (!stream.empty() &&
      plugin_push_output_ex("maneuvers", "MNV.fbs", "$MNV", PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, "MNV", 0, 0, stream.data(), static_cast<uint32_t>(stream.size())) < 0)
    return 1;
  return emit("report", {{"version", 1}, {"maneuvers", raw.size()}, {"tags", tags}});
}
