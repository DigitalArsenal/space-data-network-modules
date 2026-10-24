// -----------------------------------------------------------------------------
// The invoke surface: `ingest_omm` decodes ratified SDS $OMM FlatBuffers
// (vtable slots generated from the pinned schema, omm_slots.h) into element
// rows and replaces the element set.
// -----------------------------------------------------------------------------

#include "oem_generated.h"

namespace sdnap {

/// A plain view (p, n) of an SDS FlatBuffer given plain or size-prefixed: true when the file identifier
/// `ident` sits at the plain position (p + 4) or, after a 4-byte length that fits, at p + 8.
inline bool plain_view(const uint8_t*& p, uint32_t& n, const char* ident) {
  if (p == nullptr || n < 8) return false;
  if (std::memcmp(p + 4, ident, 4) == 0) return true;
  if (n >= 12 && std::memcmp(p + 8, ident, 4) == 0) {
    uint32_t len;
    std::memcpy(&len, p, 4);
    if (len >= 8 && len <= n - 4) {
      p += 4;
      n = len;
      return true;
    }
  }
  return false;
}

namespace omm {

inline uint32_t u32(const uint8_t* p) { uint32_t v; std::memcpy(&v, p, 4); return v; }
inline int32_t i32(const uint8_t* p) { int32_t v; std::memcpy(&v, p, 4); return v; }
inline uint16_t u16(const uint8_t* p) { uint16_t v; std::memcpy(&v, p, 2); return v; }
inline double f64(const uint8_t* p) { double v; std::memcpy(&v, p, 8); return v; }

struct Table {
  const uint8_t* buf;
  uint32_t len;
  uint32_t at;
  uint32_t vt;
  uint16_t vt_size;
};

inline bool root(const uint8_t* buf, uint32_t len, Table& t) {
  if (buf == nullptr || len < 12 || buf[4] != '$' || buf[5] != 'O' || buf[6] != 'M' || buf[7] != 'M') return false;
  t.buf = buf;
  t.len = len;
  t.at = u32(buf);
  if (t.at + 4 > len) return false;
  const int64_t vt = static_cast<int64_t>(t.at) - i32(buf + t.at);
  if (vt < 0 || vt + 4 > len) return false;
  t.vt = static_cast<uint32_t>(vt);
  t.vt_size = u16(buf + t.vt);
  return t.vt + t.vt_size <= len;
}

inline uint32_t field(const Table& t, uint16_t slot, uint32_t width) {
  if (slot + 2u > t.vt_size) return 0;
  const uint16_t off = u16(t.buf + t.vt + slot);
  if (off == 0 || t.at + off + width > t.len) return 0;
  return t.at + off;
}

inline double number(const Table& t, uint16_t slot, double fallback) {
  const uint32_t at = field(t, slot, 8);
  return at ? f64(t.buf + at) : fallback;
}

inline bool text(const Table& t, uint16_t slot, const char*& s, uint32_t& n) {
  const uint32_t at = field(t, slot, 4);
  if (!at) return false;
  const uint64_t str = static_cast<uint64_t>(at) + u32(t.buf + at);
  if (str + 4 > t.len) return false;
  n = u32(t.buf + str);
  if (str + 4 + n > t.len) return false;
  s = reinterpret_cast<const char*>(t.buf + str + 4);
  return true;
}

/// Days from 1970-01-01 of a civil date (proleptic Gregorian).
inline int64_t days_from_civil(int64_t y, int64_t m, int64_t d) {
  y -= m <= 2;
  const int64_t era = (y >= 0 ? y : y - 399) / 400;
  const int64_t yoe = y - era * 400;
  const int64_t doy = (153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1;
  const int64_t doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
  return era * 146097 + doe - 719468;
}

/// ISO 8601 "YYYY-MM-DDTHH:MM:SS[.f...][Z]" (UTC) to a split Julian date.
inline bool epoch(const char* s, uint32_t n, double& whole, double& frac) {
  auto digits = [&](uint32_t at, uint32_t count, int64_t& v) {
    if (at + count > n) return false;
    v = 0;
    for (uint32_t i = 0; i < count; ++i) {
      const char c = s[at + i];
      if (c < '0' || c > '9') return false;
      v = v * 10 + (c - '0');
    }
    return true;
  };
  int64_t y, mo, d, h = 0, mi = 0, sec = 0;
  if (!digits(0, 4, y) || n < 10 || s[4] != '-' || !digits(5, 2, mo) || s[7] != '-' || !digits(8, 2, d)) return false;
  double fraction = 0.0;
  if (n >= 19 && (s[10] == 'T' || s[10] == ' ')) {
    if (!digits(11, 2, h) || s[13] != ':' || !digits(14, 2, mi) || s[16] != ':' || !digits(17, 2, sec)) return false;
    if (n > 20 && s[19] == '.') {
      double scale = 0.1;
      for (uint32_t i = 20; i < n && s[i] >= '0' && s[i] <= '9'; ++i, scale *= 0.1) fraction += (s[i] - '0') * scale;
    }
  }
  whole = 2440587.5 + static_cast<double>(days_from_civil(y, mo, d));
  frac = (static_cast<double>(h * 3600 + mi * 60 + sec) + fraction) / 86400.0;
  return true;
}

/// Set by decode when a record names a center other than the Earth (the theories here are geocentric).
inline bool& center_refused() {
  static thread_local bool refused = false;
  return refused;
}

/// Set by decode when a geocentric record is an SDN-AP segment set (USER_DEFINED_SDNAP_REGIME CISLUNAR or HELIO):
/// propagate takes it apart from the batch; ingest refuses it.
inline bool& segment_set() {
  static thread_local bool segment = false;
  return segment;
}

inline bool decode(const uint8_t* buf, uint32_t len, ElementRow& row) {
  center_refused() = false;
  segment_set() = false;
  if (!plain_view(buf, len, "$OMM")) return false;
  {
    flatbuffers::Verifier v0(buf, len);
    if (VerifyOMMBuffer(v0)) {
      const flatbuffers::String* c = GetOMM(buf)->CENTER_NAME();
      if (c != nullptr && c->size() > 0) {
        static const char kEarth[] = "EARTH";
        bool earth = c->size() == 5;
        for (uint32_t i = 0; earth && i < 5; ++i) {
          char ch = c->c_str()[i];
          if (ch >= 'a' && ch <= 'z') ch = static_cast<char>(ch - 32);
          earth = ch == kEarth[i];
        }
        if (!earth) {
          center_refused() = true;
          return false;
        }
      }
    }
  }
  Table t{};
  if (!root(buf, len, t)) return false;
  const char* s = nullptr;
  uint32_t n = 0;
  if (!text(t, SDNAP_OMM_VT_EPOCH, s, n) || !epoch(s, n, row.epoch_jd_whole, row.epoch_jd_frac)) return false;
  const uint32_t theory_at = field(t, SDNAP_OMM_VT_MEAN_ELEMENT_THEORY, 1);
  const uint8_t theory = theory_at ? t.buf[theory_at] : 0;  // meanElementSource: SGP4 0, SGP4XP 1, SDNAP 4
  if (theory != 0 && theory != 1 && theory != 4) return false;
  row.theory = theory == 4 ? kTheorySdnAp : theory == 1 ? kTheorySgp4Xp : kTheorySgp4;
  row.mean_motion_rev_day = number(t, SDNAP_OMM_VT_MEAN_MOTION, 0.0);
  row.eccentricity = number(t, SDNAP_OMM_VT_ECCENTRICITY, 0.0);
  row.inclination_deg = number(t, SDNAP_OMM_VT_INCLINATION, 0.0);
  row.raan_deg = number(t, SDNAP_OMM_VT_RA_OF_ASC_NODE, 0.0);
  row.arg_pericenter_deg = number(t, SDNAP_OMM_VT_ARG_OF_PERICENTER, 0.0);
  row.mean_anomaly_deg = number(t, SDNAP_OMM_VT_MEAN_ANOMALY, 0.0);
  const uint32_t norad_at = field(t, SDNAP_OMM_VT_NORAD_CAT_ID, 4);
  row.norad_cat_id = norad_at ? u32(t.buf + norad_at) : 0;
  const double bstar = number(t, SDNAP_OMM_VT_BSTAR, 0.0);
  const double ddot = number(t, SDNAP_OMM_VT_MEAN_MOTION_DDOT, 0.0);
  if (row.theory == kTheorySgp4Xp || row.theory == kTheorySdnAp) {
    row.bterm = bstar;  // BTERM (SDNAP: the signed B_eff), m^2/kg
    row.agom = ddot;    // AGOM, m^2/kg
    if (row.theory == kTheorySdnAp) {
      // the SDN-AP terms without an $OMM field: USER_DEFINED_SDNAP_KAPPA, _TAU0, _TAUC, _TAUS, _ARC_END_MIN,
      // _LOWERING, _TAU_HELD; _REGIME CISLUNAR or HELIO marks a segment set
      flatbuffers::Verifier verifier(buf, len);
      if (!VerifyOMMBuffer(verifier)) return false;
      const auto* ud = GetOMM(buf)->USER_DEFINED_PARAMETERS();
      if (ud != nullptr) {
        for (const OMMUserDefinedParameter* q : *ud) {
          if (q == nullptr || q->PARAM_NAME() == nullptr || q->PARAM_VALUE() == nullptr) continue;
          const char* name = q->PARAM_NAME()->c_str();
          const char* value = q->PARAM_VALUE()->c_str();
          if (std::strcmp(name, "SDNAP_KAPPA") == 0) row.kappa = std::strtod(value, nullptr);
          else if (std::strcmp(name, "SDNAP_TAU0") == 0) row.tau0 = std::strtod(value, nullptr);
          else if (std::strcmp(name, "SDNAP_TAUC") == 0) row.tauc = std::strtod(value, nullptr);
          else if (std::strcmp(name, "SDNAP_TAUS") == 0) row.taus = std::strtod(value, nullptr);
          else if (std::strcmp(name, "SDNAP_ARC_END_MIN") == 0) row.arc_end_min = std::strtod(value, nullptr);
          else if (std::strcmp(name, "SDNAP_LOWERING") == 0 && std::strtod(value, nullptr) != 0.0) row.flags |= kFlagLowering;
          else if (std::strcmp(name, "SDNAP_TAU_HELD") == 0 && std::strtod(value, nullptr) != 0.0) row.flags |= kFlagTauHeld;
          else if (std::strcmp(name, "SDNAP_REGIME") == 0 && (std::strcmp(value, "CISLUNAR") == 0 || std::strcmp(value, "HELIO") == 0))
            segment_set() = true;
        }
      }
      if (segment_set()) return false;
    }
  } else {
    row.bstar = bstar;
    row.mean_motion_dot = number(t, SDNAP_OMM_VT_MEAN_MOTION_DOT, 0.0);
    row.mean_motion_ddot = ddot;
  }
  return row.mean_motion_rev_day > 0.0;
}

}  // namespace omm
}  // namespace sdnap

extern "C" int ingest_omm(void) {
  plugin_reset_output_state();
  const uint32_t frames = plugin_get_input_count();
  uint32_t count = 0;
  for (uint32_t i = 0; i < frames; ++i) {
    const plugin_input_frame_t* f = plugin_get_input_frame(i);
    if (f != nullptr && f->port_id != nullptr && std::strcmp(f->port_id, "omm") == 0) ++count;
  }
  if (count == 0) {
    plugin_set_error("missing-omm", "An 'omm' input frame is required.");
    return 3;
  }
  sdnap::ElementRow* rows = static_cast<sdnap::ElementRow*>(std::malloc(sizeof(sdnap::ElementRow) * count));
  if (rows == nullptr) {
    plugin_set_error("out-of-memory", "No memory for the element set.");
    return 3;
  }
  uint32_t k = 0;
  for (uint32_t i = 0; i < frames; ++i) {
    const plugin_input_frame_t* f = plugin_get_input_frame(i);
    if (f == nullptr || f->port_id == nullptr || std::strcmp(f->port_id, "omm") != 0) continue;
    sdnap::ElementRow row{};
    if (!sdnap::omm::decode(f->payload, f->payload_length, row)) {
      std::free(rows);
      if (sdnap::omm::center_refused()) {
        plugin_set_error("unsupported-center", "An 'omm' record is not centred on the Earth (CENTER_NAME); the theories here are geocentric.");
        return 3;
      }
      if (sdnap::omm::segment_set()) {
        plugin_set_error("unsupported-theory", "An 'omm' record is an SDN-AP segment set (CISLUNAR or HELIO); 'propagate' takes it, the batch does not.");
        return 3;
      }
      plugin_set_error("invalid-omm", "An 'omm' payload is not a decodable SGP4, SGP4XP or SDN-AP $OMM record.");
      return 3;
    }
    rows[k++] = row;
  }
  const int32_t held = sdnap::store_init(rows, k);
  std::free(rows);
  if (held < 0) {
    plugin_set_error("out-of-memory", "No memory for the element set.");
    return 3;
  }
  return 0;
}
