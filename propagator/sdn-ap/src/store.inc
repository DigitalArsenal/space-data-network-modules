// -----------------------------------------------------------------------------
// The element store: one fixed allocation per ingest (records, then the
// resonance checkpoints), freed by plugin_destroy. Nothing allocates while
// propagating.
// -----------------------------------------------------------------------------

namespace sdnap {

/// One element row of the structure-of-arrays ingest (sdnap_init_elements).
/// 112 bytes, little-endian, no padding.
struct ElementRow {
  double epoch_jd_whole;       ///< integer + 0.5 part of the epoch Julian date (UTC)
  double epoch_jd_frac;        ///< fraction of a day
  double mean_motion_rev_day;  ///< as carried by the set (SGP4: Kozai; SGP4-XP: Brouwer)
  double eccentricity;
  double inclination_deg;
  double raan_deg;
  double arg_pericenter_deg;
  double mean_anomaly_deg;
  double bstar;                ///< SGP4: B*, 1/earth radii
  double mean_motion_dot;      ///< rev/day^2 (carried)
  double mean_motion_ddot;     ///< rev/day^3 (carried)
  double bterm;                ///< SGP4-XP: m^2/kg
  double agom;                 ///< SGP4-XP: m^2/kg
  uint32_t norad_cat_id;
  int32_t theory;              ///< sdnap::Theory
};
static_assert(sizeof(ElementRow) == 112, "ElementRow is 112 bytes");

/// Rows hold SGP4 records (Sat) or SGP4XP records (xpt::XpSat); `slot` maps
/// a row to its record.
struct Store {
  uint32_t count = 0;
  uint8_t* kind = nullptr;     ///< 0 SGP4, 1 SGP4XP
  uint32_t* slot = nullptr;
  Sat* sats = nullptr;
  uint32_t sat_count = 0;
  xpt::XpSat* xps = nullptr;
  uint32_t xp_count = 0;
  double* nodes = nullptr;     ///< SGP4 resonance checkpoints, 4 * kCheckpointNodes doubles per resonant object
  uint32_t node_objects = 0;
};

inline Store& store() {
  static Store instance;
  return instance;
}

inline void store_free() {
  Store& st = store();
  std::free(st.kind);
  std::free(st.slot);
  std::free(st.sats);
  for (uint32_t i = 0; st.xps != nullptr && i < st.xp_count; ++i) xpt::xp_release(st.xps[i]);
  std::free(st.xps);
  std::free(st.nodes);
  st = Store{};
}

inline Elements elements_of(const ElementRow& row) {
  Elements e{};
  e.epoch_jd_whole = row.epoch_jd_whole;
  e.epoch_jd_frac = row.epoch_jd_frac;
  e.xno = row.mean_motion_rev_day * kTwoPi / kMinutesPerDay;
  e.eo = row.eccentricity;
  e.xincl = row.inclination_deg * kDeg;
  e.xnodeo = row.raan_deg * kDeg;
  e.omegao = row.arg_pericenter_deg * kDeg;
  e.xmo = row.mean_anomaly_deg * kDeg;
  e.bstar = row.bstar;
  e.ndot_rev_day2 = row.mean_motion_dot;
  e.nddot_rev_day3 = row.mean_motion_ddot;
  e.bterm = row.bterm;
  e.agom = row.agom;
  e.norad = row.norad_cat_id;
  e.theory = row.theory;
  return e;
}

/// A row the ingest takes for any theory: SGP4 or SGP4XP, every field a number and the inclination within [0, 180] deg
/// (CCSDS 502.0-B-3). Any other row is held refused (init_error), never initialized or propagated.
inline bool row_well_formed(const ElementRow& r) {
  if (r.theory != kTheorySgp4 && r.theory != kTheorySgp4Xp) return false;
  const double fields[] = {r.epoch_jd_whole, r.epoch_jd_frac, r.mean_motion_rev_day, r.eccentricity, r.inclination_deg,
                           r.raan_deg, r.arg_pericenter_deg, r.mean_anomaly_deg, r.bstar, r.mean_motion_dot,
                           r.mean_motion_ddot, r.bterm, r.agom};
  for (const double v : fields)
    if (!std::isfinite(v)) return false;
  return r.inclination_deg >= 0.0 && r.inclination_deg <= 180.0;
}

/// Replaces the element set. Returns the number of rows held (refused sets
/// are held too, flagged, so indices match the input rows), or -1 when memory
/// is exhausted.
inline int32_t store_init(const ElementRow* rows, uint32_t count) {
  store_free();
  Store& st = store();
  if (count == 0) return 0;
  uint32_t nxp = 0;
  for (uint32_t i = 0; i < count; ++i) nxp += rows[i].theory == kTheorySgp4Xp ? 1 : 0;
  const uint32_t nsat = count - nxp;
  st.kind = static_cast<uint8_t*>(std::malloc(count));
  st.slot = static_cast<uint32_t*>(std::malloc(sizeof(uint32_t) * count));
  st.sats = nsat ? static_cast<Sat*>(std::malloc(sizeof(Sat) * nsat)) : nullptr;
  st.xps = nxp ? static_cast<xpt::XpSat*>(std::malloc(sizeof(xpt::XpSat) * nxp)) : nullptr;
  if (!st.kind || !st.slot || (nsat && !st.sats) || (nxp && !st.xps)) {
    store_free();
    return -1;
  }
  static const Gravity wgs72 = gravity_wgs72();
  if (nxp > 0) drag::table();  // built once, before any thread reads it
  uint32_t resonant = 0;
  for (uint32_t i = 0; i < count; ++i) {
    const Elements e = elements_of(rows[i]);
    const bool well_formed = row_well_formed(rows[i]);
    if (e.theory == kTheorySgp4Xp) {
      st.kind[i] = 1;
      st.slot[i] = st.xp_count;
      xpt::XpSat& x = st.xps[st.xp_count++];
      if (well_formed) {
        xpt::xp_init(e, x);
      } else {
        x = xpt::XpSat{};
        x.init_error = kPropRefused;
      }
    } else {
      st.kind[i] = 0;
      st.slot[i] = st.sat_count;
      Sat& s = st.sats[st.sat_count++];
      if (well_formed) {
        sat_init(e, wgs72, s);
      } else {
        s = Sat{};
        s.init_error = kPropRefused;
      }
      if (s.init_error == 0 && s.deep.iresfl != 0) ++resonant;
    }
  }
  st.count = count;
  if (resonant > 0) {
    const size_t per = 4u * kCheckpointNodes;
    st.nodes = static_cast<double*>(std::malloc(sizeof(double) * per * resonant));
    if (st.nodes == nullptr) {
      store_free();
      return -1;
    }
    for (uint32_t i = 0; i < st.sat_count; ++i) {
      Sat& s = st.sats[i];
      if (s.init_error != 0 || s.deep.iresfl == 0) continue;
      s.checkpoint_base = static_cast<uint32_t>(st.node_objects * per);
      s.checkpoint_count = kCheckpointNodes;
      fill_checkpoints(s, st.nodes + s.checkpoint_base, kCheckpointNodes);
      ++st.node_objects;
    }
  }
  return static_cast<int32_t>(count);
}

inline const double* nodes_of(const Sat& s) {
  const Store& st = store();
  if (s.checkpoint_count == 0 || st.nodes == nullptr) return nullptr;
  return st.nodes + s.checkpoint_base;
}

/// The epoch of row i (split Julian date).
inline void row_epoch(uint32_t i, double& whole, double& frac) {
  const Store& st = store();
  if (st.kind[i] == 1) {
    whole = st.xps[st.slot[i]].epoch_jd_whole;
    frac = st.xps[st.slot[i]].epoch_jd_frac;
  } else {
    whole = st.sats[st.slot[i]].epoch_jd_whole;
    frac = st.sats[st.slot[i]].epoch_jd_frac;
  }
}

/// Row i at t minutes from its epoch: TEME km, km/s.
inline int32_t row_propagate(uint32_t i, double t, double r[3], double v[3], const xpt::Bodies* shared = nullptr) {
  Store& st = store();
  if (st.kind[i] == 1) return xpt::xp_propagate(st.xps[st.slot[i]], t, r, v, shared);
  const Sat& s = st.sats[st.slot[i]];
  return sat_propagate(s, nodes_of(s), t, r, v);
}

inline int32_t row_init_error(uint32_t i) {
  const Store& st = store();
  return st.kind[i] == 1 ? st.xps[st.slot[i]].init_error : st.sats[st.slot[i]].init_error;
}

inline uint64_t resonant_terms_bytes() {
  const Store& st = store();
  uint64_t n = 0;
  for (uint32_t i = 0; i < st.xp_count; ++i) {
    n += static_cast<uint64_t>(st.xps[i].ctx.res_count) * sizeof(xpt::res::ResCoef);
  }
  return n;
}

inline uint64_t store_bytes() {
  const Store& st = store();
  return static_cast<uint64_t>(st.count) * (1 + sizeof(uint32_t)) +
         static_cast<uint64_t>(st.sat_count) * sizeof(Sat) +
         static_cast<uint64_t>(st.xp_count) * sizeof(xpt::XpSat) +
         static_cast<uint64_t>(st.node_objects) * 4u * kCheckpointNodes * sizeof(double) + resonant_terms_bytes();
}

/// Minutes from the epoch of row i to the split Julian date (whole, frac).
inline double minutes_since_epoch(uint32_t i, double jd_whole, double jd_frac) {
  double whole, frac;
  row_epoch(i, whole, frac);
  return ((jd_whole - whole) + (jd_frac - frac)) * kMinutesPerDay;
}

/// GMST (IAU 1982) of a split Julian date, radians.
inline double gmst(double jd_whole, double jd_frac) {
  const double tut1 = ((jd_whole - 2451545.0) + jd_frac) / 36525.0;
  double temp = -6.2e-6 * tut1 * tut1 * tut1 + 0.093104 * tut1 * tut1 +
                (876600.0 * 3600.0 + 8640184.812866) * tut1 + 67310.54841;
  temp = std::fmod(temp * kDeg / 240.0, kTwoPi);
  if (temp < 0.0) temp += kTwoPi;
  return temp;
}

constexpr double kEarthRotationRate = 7.292115146706979e-5;  // rad/s

/// Earth-fixed to TEME (km, km/s both): the inverse rotation by GMST theta, the velocity giving back omega x r (polar
/// motion neglected).
inline void earth_fixed_to_teme(double theta, const double r[3], const double v[3], double ro[3], double vo[3]) {
  const double c = std::cos(theta), s = std::sin(theta);
  const double vx = v[0] - kEarthRotationRate * r[1], vy = v[1] + kEarthRotationRate * r[0];
  ro[0] = c * r[0] - s * r[1];
  ro[1] = s * r[0] + c * r[1];
  ro[2] = r[2];
  vo[0] = c * vx - s * vy;
  vo[1] = s * vx + c * vy;
  vo[2] = v[2];
}

/// TEME (km, km/s) to Earth-fixed (m, m/s): rotation by GMST, polar motion
/// neglected, the velocity picks up -omega x r.
inline void teme_to_ecef_m(double theta, const double r[3], const double v[3], double ro[3], double vo[3]) {
  const double c = std::cos(theta), s = std::sin(theta);
  ro[0] = (c * r[0] + s * r[1]) * 1000.0;
  ro[1] = (-s * r[0] + c * r[1]) * 1000.0;
  ro[2] = r[2] * 1000.0;
  const double vx = (c * v[0] + s * v[1]) * 1000.0;
  const double vy = (-s * v[0] + c * v[1]) * 1000.0;
  vo[0] = vx + kEarthRotationRate * ro[1];
  vo[1] = vy - kEarthRotationRate * ro[0];
  vo[2] = v[2] * 1000.0;
}

}  // namespace sdnap
