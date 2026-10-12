// The records the integrator reads: the composed catalog and each source's products ($OMM, $OCM, $MNV).
//
// A product names its source or it is refused: no record travels without its source (catalog pipeline C2). An
// $OMM, an $OCM and a $MNV name it in PROVENANCE (SOURCE_ID); a covariance states its realism in COV_REALISM. A product names
// its object by NORAD number or international designator; a source with neither names it natively (an $OMM's
// USER_DEFINED_OBJECT_DESIGNATOR, an $OCM's OBJECT_DESIGNATOR under the source's own CATALOG_NAME, a $MNV's ON_ORBIT)
// and that name joins an object only through an identity link the trajectories supported. Names never join.
#include <cctype>
#include <cstdio>
#include <cstdlib>
#include <memory>
#include <tuple>

namespace integrate {

constexpr size_t kMaxProducts = 250000;
constexpr size_t kMaxInputBytes = 128 * 1024 * 1024;

// ISO 8601 UTC instants (YYYY-MM-DDThh:mm:ss[.f][Z]) as microseconds since the Unix epoch. The calendar is the
// proleptic Gregorian one; a leap second (:60) is not an instant this reads.
int64_t days_from_civil(int64_t y, unsigned m, unsigned d) {
  y -= m <= 2;
  const int64_t era = (y >= 0 ? y : y - 399) / 400;
  const unsigned yoe = static_cast<unsigned>(y - era * 400);
  const unsigned doy = (153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1;
  const unsigned doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
  return era * 146097 + static_cast<int64_t>(doe) - 719468;
}
bool parse_instant(const std::string& s, int64_t* micros) {
  const size_t n = s.size();
  if (n < 19 || s[4] != '-' || s[7] != '-' || (s[10] != 'T' && s[10] != ' ') || s[13] != ':' || s[16] != ':') return false;
  auto digits = [&](size_t from, size_t count, int* out) {
    int v = 0;
    for (size_t i = from; i < from + count; ++i) {
      if (s[i] < '0' || s[i] > '9') return false;
      v = v * 10 + (s[i] - '0');
    }
    *out = v;
    return true;
  };
  int y, mo, d, h, mi, sec;
  if (!digits(0, 4, &y) || !digits(5, 2, &mo) || !digits(8, 2, &d) || !digits(11, 2, &h) || !digits(14, 2, &mi) || !digits(17, 2, &sec)) return false;
  static const int days[] = {31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31};
  const bool leap = y % 4 == 0 && (y % 100 != 0 || y % 400 == 0);
  if (y < 1 || mo < 1 || mo > 12 || d < 1 || d > days[mo - 1] + (mo == 2 && leap ? 1 : 0) || h > 23 || mi > 59 || sec > 59) return false;
  size_t at = 19;
  int64_t fraction = 0;
  if (at < n && s[at] == '.') {
    ++at;
    int count = 0;
    while (at < n && s[at] >= '0' && s[at] <= '9') {
      if (count < 6) fraction = fraction * 10 + (s[at] - '0');
      ++count;
      ++at;
    }
    if (count == 0) return false;
    for (int i = count; i < 6; ++i) fraction *= 10;
  }
  if (at < n && s[at] == 'Z') ++at;
  if (at != n) return false;
  *micros = ((days_from_civil(y, static_cast<unsigned>(mo), static_cast<unsigned>(d)) * 24 + h) * 60 + mi) * 60 * 1000000LL + static_cast<int64_t>(sec) * 1000000LL + fraction;
  return true;
}

std::string lower(std::string value) {
  for (char& c : value) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
  return value;
}
std::string hex(const uint8_t* data, size_t length) {
  static const char digits[] = "0123456789abcdef";
  std::string out;
  for (size_t i = 0; i < length; ++i) {
    out.push_back(digits[data[i] >> 4]);
    out.push_back(digits[data[i] & 15]);
  }
  return out;
}
// What the report cites a record by: its SHA-256 and the CID the store keys it by (CIDv1, raw, sha2-256).
Json record_ids(const uint8_t* data, size_t length) {
  uint8_t digest[32];
  sdn_cid::sha256_raw(data, length, digest);
  return {{"sha256", hex(digest, 32)}, {"cid", sdn_cid::cid_v1_raw_sha256(data, length)}};
}

// Size-prefixed records of one frame, in order. A zero-length prefix is alignment padding between records.
template <class Verify, class Consume>
bool each_record(const plugin_input_frame_t* frame, Verify verify, Consume consume, std::string* error) {
  const uint8_t* data = frame->payload;
  const size_t length = data ? frame->payload_length : 0;
  size_t offset = 0;
  while (offset < length) {
    if (length - offset < 4) { *error = "Truncated size prefix."; return false; }
    const auto size = flatbuffers::ReadScalar<uint32_t>(data + offset);
    if (size == 0) { offset += 4; continue; }
    if (size < 8 || size > length - offset - 4) { *error = "Invalid record length."; return false; }
    if (!verify(data + offset, size + 4)) { *error = "A record is not a valid size-prefixed FlatBuffer of the port's type."; return false; }
    consume(data + offset, static_cast<uint32_t>(size + 4));
    offset += size + 4;
  }
  return true;
}

// Whom a record is about, as the record says it.
struct Identity {
  uint32_t norad = 0;
  std::string cospar, native;
  bool any() const { return norad || !cospar.empty() || !native.empty(); }
};

struct Omm {
  size_t ordinal;
  const uint8_t* bytes;
  uint32_t length;
  std::string source, product, regime, name;
  Identity who;
  int64_t epoch;
  Json label;
};
struct Ocm {
  size_t ordinal;
  const uint8_t* bytes;
  uint32_t length;
  std::string source;
  Identity who;
  int64_t first_epoch;
  bool has_epoch;
  std::string calibration;  // the message's COV_CALIBRATION
  Json label;               // the realism of its first state (COV_REALISM[0])
};
struct Mnv {
  size_t ordinal;
  const uint8_t* bytes;
  uint32_t length;
  std::string source, id;
  Identity who;
  int64_t time;
  maneuverStatus status;
  double delta_v;  // km/s, NaN when the record states none
  std::vector<std::string> tags;
};
struct Refusal {
  const char* record;
  size_t ordinal;
  std::string reason;
};

std::string str_of(const flatbuffers::String* s) { return s ? s->str() : ""; }

// The product of an $OMM is its mean-element theory: sgp4, sgp4xp, ...
std::string product_of(meanElementSource theory) { return lower(EnumNamemeanElementSource(theory)); }

std::string source_of(const PVN* provenance) { return provenance ? str_of(provenance->SOURCE_ID()) : ""; }

// A covariance's realism (CVR) as the report states it: the rule, the model, the cell, the numbers of its test and the verdict.
Json realism_of(const CVR* c) {
  if (!c) return Json();
  Json j = {{"rule", static_cast<int>(c->RULE())}, {"ruleName", EnumNamecovarianceRule(c->RULE())},
            {"calibration", EnumNamecovarianceCalibration(c->CALIBRATION())}, {"samples", c->SAMPLES()}, {"objects", c->OBJECTS()}};
  const auto text_field = [&](const char* key, const flatbuffers::String* s) { if (s && s->size()) j[key] = s->str(); };
  const auto number_field = [&](const char* key, double v) { if (std::isfinite(v)) j[key] = v; };
  text_field("modelId", c->MODEL_ID());
  text_field("regime", c->REGIME());
  text_field("measuredLineage", c->MEASURED_LINEAGE());
  text_field("testWindow", c->TEST_WINDOW());
  text_field("evidence", c->EVIDENCE());
  number_field("ageDays", c->AGE_DAYS());
  number_field("horizonDays", c->HORIZON_DAYS());
  number_field("meanD2Over3", c->MEAN_D2_OVER_3());
  number_field("coverage95", c->COVERAGE_95());
  number_field("scaleFactor", c->SCALE_FACTOR());
  return j;
}

bool read_omm(const uint8_t* bytes, uint32_t length, size_t ordinal, std::vector<Omm>* out, std::vector<Refusal>* refused) {
  const auto* omm = GetSizePrefixedOMM(bytes);
  Omm p{ordinal, bytes, length, source_of(omm->PROVENANCE()), lower(EnumNamemeanElementSource(omm->MEAN_ELEMENT_THEORY())), "", str_of(omm->OBJECT_NAME()), {}, 0, Json()};
  if (p.source.empty()) { refused->push_back({"omm", ordinal, "unattributed-product"}); return false; }
  if (!omm->EPOCH() || !parse_instant(omm->EPOCH()->str(), &p.epoch)) { refused->push_back({"omm", ordinal, "invalid-epoch"}); return false; }
  p.who.norad = omm->NORAD_CAT_ID();
  const std::string designator = trimmed(str_of(omm->OBJECT_ID()));
  if (cospar(designator)) p.who.cospar = designator;
  p.who.native = trimmed(str_of(omm->USER_DEFINED_OBJECT_DESIGNATOR()));
  if (!p.who.any()) { refused->push_back({"omm", ordinal, "no-object-identity"}); return false; }
  p.label = realism_of(omm->COV_REALISM());
  p.regime = text(field(p.label, "regime"));
  out->push_back(std::move(p));
  return true;
}

bool read_ocm(const uint8_t* bytes, uint32_t length, size_t ordinal, std::vector<Ocm>* out, std::vector<Refusal>* refused) {
  const auto* ocm = GetSizePrefixedOCM(bytes);
  Ocm p{ordinal, bytes, length, source_of(ocm->PROVENANCE()), {}, 0, false, EnumNamecovarianceCalibration(ocm->COV_CALIBRATION()), Json()};
  if (ocm->COV_REALISM() && ocm->COV_REALISM()->size() > 0) p.label = realism_of(ocm->COV_REALISM()->Get(0));
  if (p.source.empty()) { refused->push_back({"ocm", ordinal, "unattributed-product"}); return false; }
  const auto* meta = ocm->METADATA();
  if (meta) {
    const std::string catalog = str_of(meta->CATALOG_NAME()), designator = trimmed(str_of(meta->OBJECT_DESIGNATOR()));
    const std::string international = trimmed(str_of(meta->INTERNATIONAL_DESIGNATOR()));
    if (catalog == "NORAD" && !designator.empty()) {
      char* end = nullptr;
      const unsigned long n = std::strtoul(designator.c_str(), &end, 10);
      if (end && *end == '\0' && n > 0 && n <= 0xFFFFFFFFul) p.who.norad = static_cast<uint32_t>(n);
    } else if (!designator.empty()) {
      p.who.native = designator;
    }
    if (cospar(international)) p.who.cospar = international;
  }
  if (!p.who.any()) { refused->push_back({"ocm", ordinal, "no-object-identity"}); return false; }
  if (ocm->STATE_EPOCHS() && ocm->STATE_EPOCHS()->size() > 0) p.has_epoch = parse_instant(ocm->STATE_EPOCHS()->Get(0)->str(), &p.first_epoch);
  out->push_back(std::move(p));
  return true;
}

bool read_mnv(const uint8_t* bytes, uint32_t length, size_t ordinal, std::vector<Mnv>* out, std::vector<Refusal>* refused) {
  const auto* mnv = GetSizePrefixedMNV(bytes);
  Mnv p{ordinal, bytes, length, "", str_of(mnv->ID()), {}, 0, mnv->STATUS(), NAN, {}};
  if (mnv->TAGS()) for (const auto* tag : *mnv->TAGS()) p.tags.push_back(str_of(tag));
  p.source = source_of(mnv->PROVENANCE());
  if (p.source.empty()) { refused->push_back({"mnv", ordinal, "unattributed-product"}); return false; }
  p.who.norad = mnv->SAT_NO();
  const std::string designator = trimmed(str_of(mnv->ORIG_OBJECT_ID()));
  if (cospar(designator)) p.who.cospar = designator;
  p.who.native = trimmed(str_of(mnv->ON_ORBIT()));
  if (!p.who.any()) { refused->push_back({"mnv", ordinal, "no-object-identity"}); return false; }
  const std::string at = str_of(mnv->EVENT_START_TIME()).empty() ? str_of(mnv->REPORT_TIME()) : str_of(mnv->EVENT_START_TIME());
  if (!parse_instant(at, &p.time)) { refused->push_back({"mnv", ordinal, "no-maneuver-time"}); return false; }
  double dv = mnv->DELTA_VEL();
  if (!(dv > 0)) {
    const double u = mnv->DELTA_VEL_U(), v = mnv->DELTA_VEL_V(), w = mnv->DELTA_VEL_W();
    dv = std::sqrt(u * u + v * v + w * w);
  }
  if (dv > 0 && std::isfinite(dv)) p.delta_v = dv;
  out->push_back(std::move(p));
  return true;
}

// Every record of a product port, read by `reader`. The ports hold concatenated size-prefixed records.
template <class Product, class Verify, class Reader>
bool read_port(const std::vector<const plugin_input_frame_t*>& frames, Verify verify, Reader reader, std::vector<Product>* out,
               std::vector<Refusal>* refused, size_t* bytes, std::string* error) {
  size_t ordinal = 0;
  for (const auto* frame : frames) {
    *bytes += frame->payload_length;
    if (*bytes > kMaxInputBytes) { *error = "Integration input exceeds the 128 MiB limit."; return false; }
    if (!each_record(frame, verify, [&](const uint8_t* record, uint32_t size) { reader(record, size, ordinal++, out, refused); }, error)) return false;
    if (ordinal > kMaxProducts) { *error = "Integration exceeds the 250000-record limit per product port."; return false; }
  }
  return true;
}

// The composed catalog: one canonical $CAT stream, each object once.
struct CatObject {
  size_t ordinal;
  const uint8_t* bytes;
  uint32_t length;
  uint32_t norad;
  std::string cospar, name;
  bool maneuverable;
};
bool read_catalog(const plugin_input_frame_t* frame, std::vector<CatObject>* out, std::string* error) {
  std::set<std::string> keys;
  size_t ordinal = 0;
  const bool ok = each_record(
      frame,
      [](const uint8_t* record, uint32_t size) { flatbuffers::Verifier verifier(record, size); return VerifySizePrefixedCATBuffer(verifier); },
      [&](const uint8_t* record, uint32_t size) {
        const auto* cat = GetSizePrefixedCAT(record);
        CatObject object{ordinal++, record, size, cat->NORAD_CAT_ID(), "", str_of(cat->OBJECT_NAME()), cat->MANEUVERABLE()};
        const std::string designator = trimmed(str_of(cat->OBJECT_ID()));
        if (cospar(designator)) object.cospar = designator;
        out->push_back(std::move(object));
      },
      error);
  if (!ok) return false;
  if (out->size() > kMaxProducts) { *error = "The catalog exceeds the 250000-record limit."; return false; }
  // An identity names one object: a catalog that repeats one is composed before it is integrated.
  for (const auto& object : *out) {
    for (const std::string key : {object.norad ? "norad:" + std::to_string(object.norad) : std::string(), object.cospar.empty() ? std::string() : "cospar:" + object.cospar}) {
      if (!key.empty() && !keys.insert(key).second) { *error = "The catalog repeats an object identity; compose it first."; return false; }
    }
  }
  return true;
}

}  // namespace integrate
