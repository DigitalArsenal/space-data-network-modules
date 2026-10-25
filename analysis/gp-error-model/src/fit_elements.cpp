#include <unordered_map>

// fit_elements: SGP4 mean elements (an OMM) fitted to an ephemeris by weighted
// differential correction. element_residuals: element sets scored against an
// ephemeris over time windows. Built in one translation unit after
// gp_error_model.cpp (time, SGP4, frames, element loading), common_epoch.cpp
// (find_set) and state_transition.cpp.
//
// Ephemeris ("ephemeris" port, $OEM, size-prefixed or not, any number of
// streams). Each block needs OBJECT.NORAD_CAT_ID, REFERENCE_FRAME TEME, GCRF,
// ICRF, EME2000 or J2000 (a CelestialFrameWrapper or the NAME), and
// TIME_SYSTEM UTC, TAI, TT or GPS (converted to UTC through ERFA's leap-second
// table). States come as EPHEMERIS_DATA_LINES or in the compact form
// (STEP_SIZE > 0, STATE_VECTOR_SIZE 3, 6 or 9). A line whose three velocity
// components are all zero carries no velocity. COVARIANCE_MATRIX_LINES at a
// state's epoch (within 1 ms) are that state's covariance, in
// COV_REFERENCE_FRAME: absent means the state frame; RSW, RTN, RIC or UVW (or
// an OrbitFrameWrapper RSW) means the state's radial, transverse and normal
// axes. Every state is taken to TEME (SGP4's frame): EME2000 through the
// IAU 2006 frame bias to GCRF, GCRF through foundation/frames' gcrfToTeme
// (IAU 2006/2000A and the equation of the equinoxes). Copies of an epoch
// within 1 ms keep the first in input order.
//
// The fit (fit_one): weighted least squares on the residuals model minus
// ephemeris, positions and, when asked, velocities, in TEME. Parameters are
// nonsingular equinoctial mean elements p = (n, af = e cos(w + O),
// ag = e sin(w + O), chi = tan(i/2) sin O, psi = tan(i/2) cos O,
// lambda = M + w + O), with n the Kozai mean motion (rad/min) that SGP4 takes,
// and optionally B*. The model is SGP4 (the SGP4/SDP4 base foundation/sgp4-str3,
// WGS-72, improved mode). The Jacobian is central differences: steps 1e-7 n
// for n, 1e-7 for the five dimensionless elements and 1e-7 + 1e-5 |B*| for
// B*. Steps are Levenberg-Marquardt on the Jacobi-scaled normal equations,
// starting as Gauss-Newton (damping 0, then 1e-8, multiplied by 10 on every
// rejected step). Convergence: an accepted undamped (Gauss-Newton) step whose
// relative cost decrease is at most `tolerance` (default 1e-10; a damped step's
// small decrease can be slow progress along a curved valley, and does not
// count), or, when no step lowers the cost, a
// Gauss-Newton predicted decrease of at most 1e-6 of the cost (a stationary
// point) or an unweighted position RMS at or below floorKm (default 1e-6 km,
// the numerical floor of noise-free SGP4 data). A parameter the data do not see (zero
// diagonal of the normal matrix) is held.
// The start: the osculating elements (WGS-72 mu) of the ephemeris state
// nearest the epoch, its mean anomaly carried to the epoch, then refined to
// mean elements by matching SGP4's own osculating elements at that state's
// time to the state's (osculating-to-mean inversion). Near the equator
// (osculating inclination below 3 degrees), where SDP4's cost has several
// basins in the inclination vector, the fit also starts from the osculating
// vector and from scaled and turned copies of it, and the lowest final cost is
// kept. Fits run on spans that grow by a factor of
// four, from one orbital period around that state to the whole fit span. B*
// joins only in the last stage.
// Weights: "uniform" (1 km, and sigmaVelocityKmS for velocities); "rtn" with
// sigmaRtnKm [R, T, N] in each state's own axes; or "covariance" (the state's
// covariance, position block or full 6x6, whitened by its Cholesky factor).
// With halfLifeHours, each state's weight is also scaled by
// 2^(-|t - t_ref| / halfLife), t_ref the span's end (towards "end") or start.
// With rejectSigma k > 0, states whose 3D residual exceeds k times the RMS
// are dropped and the last stage refitted, at most three times.
// Covariance: s2 (J'WJ)^-1, s2 the weighted cost over (m - p) when
// scaleCovariance (default except under covariance weights), else 1. It is
// reported in the fitted parameters, in classical elements (n rev/day, e, i,
// RAAN, argument of perigee and mean anomaly in degrees, B*; null where e or
// i is zero), and as the 6x6 Cartesian covariance at the epoch in the RSW
// axes of the fitted state. The last also goes into the OMM's COVARIANCE
// (CCSDS order, km, km/s, COV_REFERENCE_FRAME RSW_INERTIAL).
// Residual statistics (every state of the fit span, after rejection,
// unweighted): N, span, 3D RMS, per-coordinate RMS (3D RMS / sqrt(3), the
// convention of CelesTrak's SupGP rms files), R/T/N RMS and means in each
// state's RTN axes (the ephemeris velocity, or SGP4's where it has none),
// 3D, R, T and N maxima, and the velocity RMS when velocities exist.
//
// element_residuals: element sets ("elements", $OMM) propagated by the same
// SGP4 to ephemeris states, with the same statistics per requested window
// (prediction minus ephemeris, prediction age = state epoch minus set epoch).

namespace omfit {

constexpr int kMaxP = 7;
const char* const kParamNames[kMaxP] = {"n", "af", "ag", "chi", "psi", "lambda", "bstar"};

// ── UTC calendar fields of an Instant ──
void civil_from_days(int64_t z, int* y, unsigned* m, unsigned* d) {
  z += 719468;
  const int64_t era = (z >= 0 ? z : z - 146096) / 146097;
  const unsigned doe = static_cast<unsigned>(z - era * 146097);
  const unsigned yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
  const int64_t yy = static_cast<int64_t>(yoe) + era * 400;
  const unsigned doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
  const unsigned mp = (5 * doy + 2) / 153;
  *d = doy - (153 * mp + 2) / 5 + 1;
  *m = mp < 10 ? mp + 3 : mp - 9;
  *y = static_cast<int>(yy + (*m <= 2));
}
void fields(const Instant& t, int ymdhm[5], double* sec) {
  int y;
  unsigned m, d;
  civil_from_days(t.day, &y, &m, &d);
  int h = static_cast<int>(t.sec / 3600.0);
  if (h > 23) h = 23;
  int mi = static_cast<int>((t.sec - h * 3600.0) / 60.0);
  if (mi > 59) mi = 59;
  ymdhm[0] = y; ymdhm[1] = static_cast<int>(m); ymdhm[2] = static_cast<int>(d); ymdhm[3] = h; ymdhm[4] = mi;
  *sec = t.sec - h * 3600.0 - mi * 60.0;
}
// ISO 8601 UTC with microseconds.
std::string iso(const Instant& t) {
  int64_t day = t.day;
  double us = std::round(t.sec * 1e6);
  if (us >= 86400e6) { day += 1; us -= 86400e6; }
  int y;
  unsigned m, d;
  civil_from_days(day, &y, &m, &d);
  int64_t u = static_cast<int64_t>(us);
  const int h = static_cast<int>(u / 3600000000LL); u -= int64_t(h) * 3600000000LL;
  const int mi = static_cast<int>(u / 60000000LL); u -= int64_t(mi) * 60000000LL;
  const int s = static_cast<int>(u / 1000000LL); u -= int64_t(s) * 1000000LL;
  char buf[48];
  std::snprintf(buf, sizeof buf, "%04d-%02u-%02uT%02d:%02d:%02d.%06lld", y, m, d, h, mi, s, static_cast<long long>(u));
  return buf;
}
int64_t micro_key(const Instant& t) { return t.day * 86400000000LL + static_cast<int64_t>(std::llround(t.sec * 1e6)); }

// An epoch in a block's time system as a UTC instant (ERFA's leap-second table).
bool utc_instant(timingStandard ts, const std::string& text, Instant* out) {
  int ymdhm[5];
  double sec;
  Instant t;
  if (!parse_instant(text, &t, ymdhm, &sec)) return false;
  if (ts == timingStandard::UTC) { *out = t; return true; }
  if (ts != timingStandard::TAI && ts != timingStandard::TT && ts != timingStandard::GPS) return false;
  double d1, d2, a1, a2, u1, u2;
  if (eraDtf2d(ts == timingStandard::TT ? "TT" : "TAI", ymdhm[0], ymdhm[1], ymdhm[2], ymdhm[3], ymdhm[4], sec, &d1, &d2) < 0) return false;
  a1 = d1; a2 = d2;
  if (ts == timingStandard::TT && eraTttai(d1, d2, &a1, &a2) != 0) return false;
  if (ts == timingStandard::GPS) a2 += 19.0 / 86400.0;  // TAI = GPS + 19 s
  if (eraTaiutc(a1, a2, &u1, &u2) < 0) return false;
  int iy, im, id, f[4];
  if (eraD2dtf("UTC", 6, u1, u2, &iy, &im, &id, f) < 0) return false;
  out->day = days_from_civil(iy, static_cast<unsigned>(im), static_cast<unsigned>(id));
  out->sec = f[0] * 3600.0 + f[1] * 60.0 + f[2] + f[3] * 1e-6;
  return true;
}

// ── frames ──
enum class Frame { kTeme, kGcrf, kEme2000, kUnsupported };
Frame frame_of(const RFM* f) {
  if (!f) return Frame::kUnsupported;
  if (f->REFERENCE_FRAME_type() == RFMUnion::CelestialFrameWrapper && f->REFERENCE_FRAME_as_CelestialFrameWrapper()) {
    switch (f->REFERENCE_FRAME_as_CelestialFrameWrapper()->frame()) {
      case CelestialFrame::TEMEOFDATE: return Frame::kTeme;
      case CelestialFrame::GCRF:
      case CelestialFrame::ICRF: return Frame::kGcrf;
      case CelestialFrame::EME2000:
      case CelestialFrame::J2000: return Frame::kEme2000;
      default: return Frame::kUnsupported;
    }
  }
  if (f->NAME()) {
    const std::string n = f->NAME()->str();
    if (n == "TEME" || n == "TEMEOFDATE") return Frame::kTeme;
    if (n == "GCRF" || n == "ICRF") return Frame::kGcrf;
    if (n == "EME2000" || n == "J2000") return Frame::kEme2000;
  }
  return Frame::kUnsupported;
}
const char* frame_name(Frame f) {
  return f == Frame::kTeme ? "TEME" : f == Frame::kGcrf ? "GCRF" : f == Frame::kEme2000 ? "EME2000" : "unsupported";
}
enum class CovFrame { kSame, kRsw, kUnsupported };
CovFrame cov_frame_of(const RFM* f, Frame state) {
  if (!f) return CovFrame::kSame;
  if (f->REFERENCE_FRAME_type() == RFMUnion::OrbitFrameWrapper && f->REFERENCE_FRAME_as_OrbitFrameWrapper()) {
    const OrbitFrame o = f->REFERENCE_FRAME_as_OrbitFrameWrapper()->frame();
    return o == OrbitFrame::RSW_INERTIAL || o == OrbitFrame::RSW_ROTATING ? CovFrame::kRsw : CovFrame::kUnsupported;
  }
  if (f->NAME()) {
    const std::string n = f->NAME()->str();
    if (n == "RSW" || n == "RTN" || n == "RIC" || n == "UVW") return CovFrame::kRsw;
  }
  return frame_of(f) == state ? CovFrame::kSame : CovFrame::kUnsupported;
}

using M3 = fr::Mat3;
M3 bias_matrix() {  // GCRF -> mean equator and equinox of J2000 (IAU 2006 frame bias)
  double rb[3][3], rp[3][3], rbp[3][3];
  eraBp06(ERFA_DJ00, 0.0, rb, rp, rbp);
  return fr::detail::fromErfa(rb);
}
struct Rotations {
  std::unordered_map<int64_t, M3> gcrf_to_teme;
  M3 bias = bias_matrix();
  // Rotation taking a state in `f` at UTC instant t to TEME.
  bool to_teme(const Instant& t, Frame f, M3* out) {
    if (f == Frame::kTeme) { *out = M3{}; return true; }
    const int64_t key = micro_key(t);
    auto it = gcrf_to_teme.find(key);
    if (it == gcrf_to_teme.end()) {
      int ymdhm[5];
      double sec;
      fields(t, ymdhm, &sec);
      fr::EarthOrientation none;  // TEME <-> GCRF needs TT only
      fr::Epoch e;
      if (!fr::epochFromUtc(ymdhm[0], ymdhm[1], ymdhm[2], ymdhm[3], ymdhm[4], sec, none, &e)) return false;
      it = gcrf_to_teme.emplace(key, fr::gcrfToTeme(e)).first;
    }
    *out = f == Frame::kGcrf ? it->second : fr::multiply(it->second, fr::transpose(bias));
    return true;
  }
};
void apply3(const M3& m, const double x[3], double y[3]) {
  for (int a = 0; a < 3; ++a) y[a] = m.m[a][0] * x[0] + m.m[a][1] * x[1] + m.m[a][2] * x[2];
}

// ── ephemeris ──
struct State {
  Instant t;
  double r[3] = {}, v[3] = {};  // TEME, km and km/s
  bool has_v = false;
  bool has_cov = false;
  std::array<double, 36> cov{};  // TEME, full 6x6 row-major, km and km/s
  uint32_t stream = 0;
  uint32_t order = 0;
};
struct Track {
  std::string name, id;
  std::vector<State> states;
};
using Tracks = std::map<uint32_t, Track>;
struct LoadCounts {
  uint64_t streams = 0, blocks = 0, states = 0, duplicates = 0, covariances = 0, unmatchedCovariances = 0;
  std::map<std::string, uint64_t> frames;
};

// RSW rows (R, T, N) of a state, as ffmcal::rtn_axes builds them.
void rsw_rows(const double r[3], const double v[3], double rows[3][3]) { ffmcal::rtn_axes(r, v, rows); }

std::string load_tracks(Tracks* out, LoadCounts* counts) {
  Rotations rot;
  uint32_t stream = 0, order = 0;
  for (uint32_t i = 0; i < plugin_get_input_count(); ++i) {
    const plugin_input_frame_t* f = plugin_get_input_frame(i);
    if (!f || !f->port_id || std::strcmp(f->port_id, "ephemeris") != 0) continue;
    const uint32_t this_stream = stream++;
    ++counts->streams;
    const uint8_t* p = f->payload;
    const size_t n = f->payload_length;
    const bool prefixed = n >= 8 && flatbuffers::BufferHasIdentifier(p, OEMIdentifier(), true);
    flatbuffers::Verifier::Options vo;
    vo.max_tables = 50000000;
    vo.max_size = 0x7FFFFFFF;
    flatbuffers::Verifier verifier(p, n, vo);
    if (prefixed ? !VerifySizePrefixedOEMBuffer(verifier) : !VerifyOEMBuffer(verifier))
      return "each ephemeris frame must be a verifiable $OEM.";
    const OEM* oem = prefixed ? GetSizePrefixedOEM(p) : GetOEM(p);
    if (!oem->EPHEMERIS_DATA_BLOCK()) continue;
    for (const ephemerisDataBlock* b : *oem->EPHEMERIS_DATA_BLOCK()) {
      ++counts->blocks;
      if (!b->OBJECT() || !b->OBJECT()->NORAD_CAT_ID()) return "each ephemeris block needs OBJECT.NORAD_CAT_ID.";
      const Frame fk = frame_of(b->REFERENCE_FRAME());
      if (fk == Frame::kUnsupported) return "ephemeris REFERENCE_FRAME must be TEME, GCRF, ICRF, EME2000 or J2000.";
      const timingStandard ts = b->TIME_SYSTEM();
      if (ts != timingStandard::UTC && ts != timingStandard::TAI && ts != timingStandard::TT && ts != timingStandard::GPS)
        return "ephemeris TIME_SYSTEM must be UTC, TAI, TT or GPS.";
      const CovFrame cf = cov_frame_of(b->COV_REFERENCE_FRAME(), fk);
      ++counts->frames[frame_name(fk)];
      Track& tr = (*out)[b->OBJECT()->NORAD_CAT_ID()];
      if (tr.name.empty() && b->OBJECT()->OBJECT_NAME()) tr.name = b->OBJECT()->OBJECT_NAME()->str();
      if (tr.id.empty() && b->OBJECT()->OBJECT_ID()) tr.id = b->OBJECT()->OBJECT_ID()->str();
      std::vector<State> got;
      if (b->STEP_SIZE() > 0 && b->EPHEMERIS_DATA()) {
        const int k = b->STATE_VECTOR_SIZE();
        if (k != 3 && k != 6 && k != 9) return "STATE_VECTOR_SIZE must be 3, 6 or 9.";
        Instant start;
        if (!b->START_TIME() || !utc_instant(ts, b->START_TIME()->str(), &start)) return "compact ephemeris needs a START_TIME.";
        const auto* d = b->EPHEMERIS_DATA();
        if (d->size() % k != 0) return "EPHEMERIS_DATA length must be a multiple of STATE_VECTOR_SIZE.";
        for (uint32_t j = 0; j * k < d->size(); ++j) {
          State s;
          s.t = ffmcal::plus_seconds(start, j * b->STEP_SIZE());
          for (int a = 0; a < 3; ++a) s.r[a] = d->Get(j * k + a);
          if (k >= 6) {
            for (int a = 0; a < 3; ++a) s.v[a] = d->Get(j * k + 3 + a);
            s.has_v = s.v[0] != 0 || s.v[1] != 0 || s.v[2] != 0;
          }
          got.push_back(s);
        }
      } else if (b->EPHEMERIS_DATA_LINES()) {
        for (const ephemerisDataLine* l : *b->EPHEMERIS_DATA_LINES()) {
          State s;
          if (!l->EPOCH() || !utc_instant(ts, l->EPOCH()->str(), &s.t)) return "ephemeris epoch is not ISO 8601 or outside the leap-second table.";
          s.r[0] = l->X(); s.r[1] = l->Y(); s.r[2] = l->Z();
          s.v[0] = l->X_DOT(); s.v[1] = l->Y_DOT(); s.v[2] = l->Z_DOT();
          s.has_v = s.v[0] != 0 || s.v[1] != 0 || s.v[2] != 0;
          got.push_back(s);
        }
      }
      // Covariance lines, by epoch, in the block's covariance frame.
      std::unordered_map<int64_t, std::array<double, 36>> covs;
      if (b->COVARIANCE_MATRIX_LINES()) {
        if (cf == CovFrame::kUnsupported) return "COV_REFERENCE_FRAME must be the state frame or RSW/RTN/RIC/UVW.";
        for (const covarianceMatrixLine* c : *b->COVARIANCE_MATRIX_LINES()) {
          Instant t;
          if (!c->EPOCH() || !utc_instant(ts, c->EPOCH()->str(), &t)) return "covariance epoch is not ISO 8601.";
          const double lt[21] = {c->CX_X(), c->CY_X(), c->CY_Y(), c->CZ_X(), c->CZ_Y(), c->CZ_Z(),
                                 c->CX_DOT_X(), c->CX_DOT_Y(), c->CX_DOT_Z(), c->CX_DOT_X_DOT(),
                                 c->CY_DOT_X(), c->CY_DOT_Y(), c->CY_DOT_Z(), c->CY_DOT_X_DOT(), c->CY_DOT_Y_DOT(),
                                 c->CZ_DOT_X(), c->CZ_DOT_Y(), c->CZ_DOT_Z(), c->CZ_DOT_X_DOT(), c->CZ_DOT_Y_DOT(), c->CZ_DOT_Z_DOT()};
          std::array<double, 36> m{};
          for (int a = 0, q = 0; a < 6; ++a)
            for (int bb = 0; bb <= a; ++bb, ++q) m[6 * a + bb] = m[6 * bb + a] = lt[q];
          covs[micro_key(t) / 1000] = m;  // matched within a millisecond
        }
      }
      for (State& s : got) {
        M3 m;
        if (!rot.to_teme(s.t, fk, &m)) return "ephemeris epoch outside the leap-second table.";
        double r[3], v[3];
        apply3(m, s.r, r);
        apply3(m, s.v, v);
        std::copy(r, r + 3, s.r);
        std::copy(v, v + 3, s.v);
        auto c = covs.find(micro_key(s.t) / 1000);
        if (c != covs.end()) {
          // Covariance to TEME: inertial frames rotate with m; RSW rotates with the state's axes.
          double rows[3][3];
          M3 q;
          if (cf == CovFrame::kRsw) {
            if (!s.has_v) { ++counts->unmatchedCovariances; c = covs.end(); }
            else {
              rsw_rows(s.r, s.v, rows);
              for (int a = 0; a < 3; ++a)
                for (int bb = 0; bb < 3; ++bb) q.m[a][bb] = rows[bb][a];  // RSW -> TEME is the transpose of the rows
            }
          } else {
            q = m;
          }
          if (c != covs.end()) {
            std::array<double, 36> out6{};
            for (int a = 0; a < 6; ++a)
              for (int bb = 0; bb < 6; ++bb) {
                double sum = 0;
                for (int k1 = 0; k1 < 6; ++k1) {
                  const double qa = (a / 3 == k1 / 3) ? q.m[a % 3][k1 % 3] : 0.0;
                  if (qa == 0) continue;
                  for (int k2 = 0; k2 < 6; ++k2) {
                    const double qb = (bb / 3 == k2 / 3) ? q.m[bb % 3][k2 % 3] : 0.0;
                    if (qb != 0) sum += qa * c->second[6 * k1 + k2] * qb;
                  }
                }
                out6[6 * a + bb] = sum;
              }
            s.cov = out6;
            s.has_cov = true;
            ++counts->covariances;
          }
        }
        s.stream = this_stream;
        s.order = order++;
        tr.states.push_back(s);
        ++counts->states;
      }
    }
  }
  for (auto& [norad, tr] : *out) {
    std::stable_sort(tr.states.begin(), tr.states.end(), [](const State& a, const State& b) { return before(a.t, b.t); });
    std::vector<State> unique;
    unique.reserve(tr.states.size());
    for (const State& s : tr.states) {
      if (!unique.empty() && std::fabs(seconds_between(unique.back().t, s.t)) < 1e-3) {
        ++counts->duplicates;
        if (s.order < unique.back().order) unique.back() = s;
        continue;
      }
      unique.push_back(s);
    }
    tr.states.swap(unique);
  }
  return {};
}

// ── SGP4 in equinoctial parameters ──
double wrap2pi(double a) {
  a = std::fmod(a, 2 * kPi);
  return a < 0 ? a + 2 * kPi : a;
}
// p (n, af, ag, chi, psi, lambda, bstar) -> classical (n, e, i, raan, argp, M, bstar), radians.
bool classical(const double p[kMaxP], double el[kMaxP]) {
  const double e = std::hypot(p[1], p[2]);
  if (!(p[0] > 0) || !(e < 1) || !std::isfinite(e)) return false;
  const double varpi = e > 0 ? std::atan2(p[2], p[1]) : 0.0;
  const double t = std::hypot(p[3], p[4]);
  const double raan = t > 0 ? std::atan2(p[3], p[4]) : 0.0;
  el[0] = p[0];
  el[1] = e;
  el[2] = 2 * std::atan(t);
  el[3] = wrap2pi(raan);
  el[4] = wrap2pi(varpi - raan);
  el[5] = wrap2pi(p[5] - varpi);
  el[6] = p[6];
  return true;
}
void equinoctial(const double el[kMaxP], double p[kMaxP]) {
  const double varpi = el[4] + el[3], t = std::tan(el[2] / 2);
  p[0] = el[0];
  p[1] = el[1] * std::cos(varpi);
  p[2] = el[1] * std::sin(varpi);
  p[3] = t * std::sin(el[3]);
  p[4] = t * std::cos(el[3]);
  p[5] = el[5] + varpi;
  p[6] = el[6];
}
bool init_rec(double sgp4_epoch, const double p[kMaxP], sdnap::Sat& rec) {
  double el[kMaxP];
  if (!classical(p, el)) return false;
  return sgp4_init(sgp4_epoch, el[6], el[1], el[4], el[2], el[5], el[0], el[3], rec);
}
bool sgp4_at(sdnap::Sat& rec, double minutes, double x[6]) {
  double r[3], v[3];
  if (!sgp4_eval(rec, minutes, r, v) || !std::isfinite(r[0])) return false;
  std::copy(r, r + 3, x);
  std::copy(v, v + 3, x + 3);
  return true;
}

// Osculating classical elements (WGS-72 mu) of a TEME state: n (rad/min), e, i, raan, argp, M.
bool osculating(const double r[3], const double v[3], double el[6]) {
  const double rn = std::sqrt(r[0] * r[0] + r[1] * r[1] + r[2] * r[2]);
  const double vv = v[0] * v[0] + v[1] * v[1] + v[2] * v[2];
  const double h[3] = {r[1] * v[2] - r[2] * v[1], r[2] * v[0] - r[0] * v[2], r[0] * v[1] - r[1] * v[0]};
  const double hn = std::sqrt(h[0] * h[0] + h[1] * h[1] + h[2] * h[2]);
  const double energy = vv / 2 - kMuWgs72 / rn;
  if (!(energy < 0) || !(hn > 0)) return false;
  const double a = -kMuWgs72 / (2 * energy);
  const double rv = r[0] * v[0] + r[1] * v[1] + r[2] * v[2];
  double ev[3];
  for (int k = 0; k < 3; ++k) ev[k] = ((vv - kMuWgs72 / rn) * r[k] - rv * v[k]) / kMuWgs72;
  const double e = std::sqrt(ev[0] * ev[0] + ev[1] * ev[1] + ev[2] * ev[2]);
  const double inc = std::acos(std::max(-1.0, std::min(1.0, h[2] / hn)));
  const double nvec[2] = {-h[1], h[0]};
  const double nn = std::hypot(nvec[0], nvec[1]);
  double raan = nn > 1e-12 ? std::atan2(nvec[1], nvec[0]) : 0.0;
  // Argument of latitude u and true anomaly nu; with e ~ 0 or i ~ 0 the
  // split is arbitrary, and the equinoctial parameters do not depend on it.
  const double ux = nn > 1e-12 ? (r[0] * nvec[0] + r[1] * nvec[1]) / (rn * nn) : r[0] / rn;
  const double uy = nn > 1e-12 ? r[2] / (rn * std::sin(inc)) : r[1] / rn;
  const double u = std::atan2(uy, ux);
  double argp = 0, nu = u;
  if (e > 1e-10) {
    const double cosnu = (ev[0] * r[0] + ev[1] * r[1] + ev[2] * r[2]) / (e * rn);
    nu = std::acos(std::max(-1.0, std::min(1.0, cosnu)));
    if (rv < 0) nu = 2 * kPi - nu;
    argp = u - nu;
  }
  const double E = 2 * std::atan2(std::sqrt(1 - e) * std::sin(nu / 2), std::sqrt(1 + e) * std::cos(nu / 2));
  const double M = E - e * std::sin(E);
  el[0] = std::sqrt(kMuWgs72 / (a * a * a)) * 60.0;
  el[1] = e;
  el[2] = inc;
  el[3] = wrap2pi(raan);
  el[4] = wrap2pi(argp);
  el[5] = wrap2pi(M);
  return std::isfinite(el[0]) && std::isfinite(el[5]);
}

// ── fit options ──
struct FitOptions {
  bool has_from = false, has_to = false;
  Instant from, to;
  std::string epoch_mode = "first";
  Instant epoch;
  double step_s = 0;
  bool fit_bstar = true;
  bool bstar_given = false;
  double bstar = 0;
  std::string bstar_source;  // "apriori"
  std::string weighting = "uniform";
  double sigma_rtn[3] = {1, 1, 1};
  bool use_velocity = false;
  double sigma_v = 1e-3;
  double half_life_h = 0;
  bool towards_end = true;
  int max_iter = 100;
  double tolerance = 1e-10;
  double floor_km = 1e-6;
  std::string initial = "ephemeris";
  double reject_k = 0;
  bool scale_cov = true, scale_cov_given = false;
  bool residuals = false;
  bool closure = true;
  int stream = -1;
  std::string originator, creation_date, classification, comment, object_name, object_id;
  int64_t element_set_no = -1;
};

std::string read_fit_options(const nlohmann::json& j, FitOptions* o) {
  if (!j.is_object()) return {};
  auto instant = [&](const char* key, Instant* out, bool* has) -> std::string {
    if (!j.contains(key)) return {};
    if (!j[key].is_string() || !parse_instant(j[key].get<std::string>(), out)) return std::string(key) + " is not ISO 8601 UTC.";
    if (has) *has = true;
    return {};
  };
  std::string e;
  if (!(e = instant("from", &o->from, &o->has_from)).empty()) return e;
  if (!(e = instant("to", &o->to, &o->has_to)).empty()) return e;
  if (j.contains("epoch")) {
    if (!j["epoch"].is_string()) return "epoch is first, last, middle or an ISO 8601 UTC instant.";
    const std::string m = j["epoch"].get<std::string>();
    if (m == "first" || m == "last" || m == "middle") o->epoch_mode = m;
    else if (parse_instant(m, &o->epoch)) o->epoch_mode = "explicit";
    else return "epoch is first, last, middle or an ISO 8601 UTC instant.";
  }
  auto num = [&](const char* key, double* out, double lo, double hi) -> std::string {
    if (!j.contains(key)) return {};
    if (!j[key].is_number() || !(j[key].get<double>() >= lo && j[key].get<double>() <= hi)) return std::string(key) + " is out of range.";
    *out = j[key].get<double>();
    return {};
  };
  if (!(e = num("stepSeconds", &o->step_s, 0, 1e7)).empty()) return e;
  if (j.contains("fitBstar")) {
    if (!j["fitBstar"].is_boolean()) return "fitBstar is a boolean.";
    o->fit_bstar = j["fitBstar"].get<bool>();
  }
  if (j.contains("bstar")) {
    if (j["bstar"].is_number()) { o->bstar = j["bstar"].get<double>(); o->bstar_given = true; o->bstar_source.clear(); }
    else if (j["bstar"].is_string() && j["bstar"].get<std::string>() == "apriori") o->bstar_source = "apriori";
    else return "bstar is a number or \"apriori\".";
  }
  if (j.contains("weighting")) {
    if (!j["weighting"].is_string()) return "weighting is uniform, rtn or covariance.";
    o->weighting = j["weighting"].get<std::string>();
    if (o->weighting != "uniform" && o->weighting != "rtn" && o->weighting != "covariance") return "weighting is uniform, rtn or covariance.";
  }
  if (j.contains("sigmaRtnKm")) {
    if (!j["sigmaRtnKm"].is_array() || j["sigmaRtnKm"].size() != 3) return "sigmaRtnKm is [R, T, N] in km.";
    for (int k = 0; k < 3; ++k) {
      if (!j["sigmaRtnKm"][k].is_number() || !(j["sigmaRtnKm"][k].get<double>() > 0)) return "sigmaRtnKm entries are positive.";
      o->sigma_rtn[k] = j["sigmaRtnKm"][k].get<double>();
    }
  }
  if (j.contains("velocity")) {
    if (!j["velocity"].is_boolean()) return "velocity is a boolean.";
    o->use_velocity = j["velocity"].get<bool>();
  }
  if (!(e = num("sigmaVelocityKmS", &o->sigma_v, 1e-12, 1e3)).empty()) return e;
  if (!(e = num("halfLifeHours", &o->half_life_h, 0, 1e6)).empty()) return e;
  if (j.contains("towards")) {
    if (!j["towards"].is_string() || (j["towards"] != "end" && j["towards"] != "start")) return "towards is end or start.";
    o->towards_end = j["towards"] == "end";
  }
  if (j.contains("maxIterations")) {
    if (!j["maxIterations"].is_number_integer() || j["maxIterations"].get<int>() < 1 || j["maxIterations"].get<int>() > 1000)
      return "maxIterations is 1 to 1000.";
    o->max_iter = j["maxIterations"].get<int>();
  }
  if (!(e = num("tolerance", &o->tolerance, 0, 1)).empty()) return e;
  if (!(e = num("floorKm", &o->floor_km, 0, 1)).empty()) return e;
  if (j.contains("initial")) {
    if (!j["initial"].is_string() || (j["initial"] != "ephemeris" && j["initial"] != "apriori")) return "initial is ephemeris or apriori.";
    o->initial = j["initial"].get<std::string>();
  }
  if (!(e = num("rejectSigma", &o->reject_k, 0, 1e6)).empty()) return e;
  if (j.contains("scaleCovariance")) {
    if (!j["scaleCovariance"].is_boolean()) return "scaleCovariance is a boolean.";
    o->scale_cov = j["scaleCovariance"].get<bool>();
    o->scale_cov_given = true;
  }
  if (j.contains("residuals")) {
    if (!j["residuals"].is_boolean()) return "residuals is a boolean.";
    o->residuals = j["residuals"].get<bool>();
  }
  if (j.contains("ephemerisStream")) {
    if (!j["ephemerisStream"].is_number_unsigned()) return "ephemerisStream is a stream index.";
    o->stream = j["ephemerisStream"].get<int>();
  }
  if (j.contains("closure")) {
    if (!j["closure"].is_boolean()) return "closure is a boolean.";
    o->closure = j["closure"].get<bool>();
  }
  auto text = [&](const char* key, std::string* out) -> std::string {
    if (!j.contains(key)) return {};
    if (!j[key].is_string()) return std::string(key) + " is a string.";
    *out = j[key].get<std::string>();
    return {};
  };
  for (auto [key, out] : {std::pair<const char*, std::string*>{"originator", &o->originator}, {"creationDate", &o->creation_date},
                          {"classification", &o->classification}, {"comment", &o->comment}, {"objectName", &o->object_name},
                          {"objectId", &o->object_id}})
    if (!(e = text(key, out)).empty()) return e;
  if (j.contains("elementSetNo")) {
    if (!j["elementSetNo"].is_number_unsigned()) return "elementSetNo is a non-negative integer.";
    o->element_set_no = j["elementSetNo"].get<int64_t>();
  }
  return {};
}

// ── residual statistics ──
struct Stats {
  uint64_t n = 0, nv = 0, failures = 0;
  double sum2 = 0, sum2v = 0, rtn2[3] = {}, rtn1[3] = {}, max3 = 0, maxc[3] = {};
  Instant first, last, max_at;
  void add(const State& s, const double model[6]) {
    double e[3], ax[3][3];
    for (int a = 0; a < 3; ++a) e[a] = model[a] - s.r[a];
    rsw_rows(s.r, s.has_v ? s.v : model + 3, ax);
    const double d2 = e[0] * e[0] + e[1] * e[1] + e[2] * e[2];
    if (n == 0) first = s.t;
    last = s.t;
    ++n;
    sum2 += d2;
    if (std::sqrt(d2) > max3) { max3 = std::sqrt(d2); max_at = s.t; }
    for (int c = 0; c < 3; ++c) {
      const double x = ax[c][0] * e[0] + ax[c][1] * e[1] + ax[c][2] * e[2];
      rtn2[c] += x * x;
      rtn1[c] += x;
      maxc[c] = std::max(maxc[c], std::fabs(x));
    }
    if (s.has_v) {
      double dv2 = 0;
      for (int a = 0; a < 3; ++a) dv2 += (model[3 + a] - s.v[a]) * (model[3 + a] - s.v[a]);
      sum2v += dv2;
      ++nv;
    }
  }
  nlohmann::json json() const {
    nlohmann::json j{{"n", n}};
    if (n == 0) { j["failures"] = failures; return j; }
    const double nn = static_cast<double>(n);
    j["span"] = {iso(first), iso(last)};
    j["rms3dKm"] = std::sqrt(sum2 / nn);
    j["rmsPerCoordinateKm"] = std::sqrt(sum2 / (3 * nn));
    j["rmsRtnKm"] = {std::sqrt(rtn2[0] / nn), std::sqrt(rtn2[1] / nn), std::sqrt(rtn2[2] / nn)};
    j["meanRtnKm"] = {rtn1[0] / nn, rtn1[1] / nn, rtn1[2] / nn};
    j["max3dKm"] = max3;
    j["maxAt"] = iso(max_at);
    j["maxRtnKm"] = {maxc[0], maxc[1], maxc[2]};
    if (nv) j["rmsVelocityKmS"] = std::sqrt(sum2v / static_cast<double>(nv));
    j["failures"] = failures;
    return j;
  }
};

// ── one fit ──
struct Obs {
  const State* s;
  double minutes;
  int d;           // 3 or 6
  double U[36];    // whitening, d x d row-major: z = U e
};
struct Problem {
  double sgp4_epoch;
  bool active[kMaxP];
  int np;
};

// Model states at every observation; false when SGP4 fails anywhere.
bool evaluate(const Problem& pr, const double p[kMaxP], const std::vector<Obs>& obs, std::vector<std::array<double, 6>>* x) {
  sdnap::Sat rec;
  if (!init_rec(pr.sgp4_epoch, p, rec)) return false;
  x->resize(obs.size());
  for (size_t k = 0; k < obs.size(); ++k)
    if (!sgp4_at(rec, obs[k].minutes, (*x)[k].data())) return false;
  return true;
}
void whiten(const Obs& o, const double model[6], double z[6]) {
  double e[6];
  for (int a = 0; a < 3; ++a) e[a] = model[a] - o.s->r[a];
  if (o.d == 6)
    for (int a = 0; a < 3; ++a) e[3 + a] = model[3 + a] - o.s->v[a];
  for (int a = 0; a < o.d; ++a) {
    double s = 0;
    for (int b = 0; b < o.d; ++b) s += o.U[o.d * a + b] * e[b];
    z[a] = s;
  }
}
double cost_of(const std::vector<Obs>& obs, const std::vector<std::array<double, 6>>& x) {
  double c = 0;
  for (size_t k = 0; k < obs.size(); ++k) {
    double z[6];
    whiten(obs[k], x[k].data(), z);
    for (int a = 0; a < obs[k].d; ++a) c += z[a] * z[a];
  }
  return c;
}
double step_of(int j, const double p[kMaxP]) {
  return j == 0 ? 1e-7 * p[0] : j == 6 ? 1e-7 + 1e-5 * std::fabs(p[6]) : 1e-7;
}
// Jacobian of the model at every observation (6 x np per observation, active parameters in order).
bool jacobian(const Problem& pr, const double p[kMaxP], const std::vector<Obs>& obs, std::vector<double>* J) {
  J->assign(obs.size() * 6 * pr.np, 0.0);
  std::vector<std::array<double, 6>> xp, xm;
  for (int j = 0, col = 0; j < kMaxP; ++j) {
    if (!pr.active[j]) continue;
    const double h = step_of(j, p);
    double pp[kMaxP], pm[kMaxP];
    std::copy(p, p + kMaxP, pp);
    std::copy(p, p + kMaxP, pm);
    pp[j] += h;
    pm[j] -= h;
    if (!evaluate(pr, pp, obs, &xp) || !evaluate(pr, pm, obs, &xm)) return false;
    for (size_t k = 0; k < obs.size(); ++k)
      for (int c = 0; c < 6; ++c) (*J)[(k * 6 + c) * pr.np + col] = (xp[k][c] - xm[k][c]) / (2 * h);
    ++col;
  }
  return true;
}
// Normal equations N = sum (U J)'(U J), g = sum (U J)'(U e).
void normal(const Problem& pr, const std::vector<Obs>& obs, const std::vector<double>& J,
            const std::vector<std::array<double, 6>>& x, std::vector<double>* N, std::vector<double>* g) {
  const int np = pr.np;
  N->assign(np * np, 0.0);
  g->assign(np, 0.0);
  std::vector<double> UJ(6 * np);
  for (size_t k = 0; k < obs.size(); ++k) {
    const Obs& o = obs[k];
    double z[6];
    whiten(o, x[k].data(), z);
    for (int a = 0; a < o.d; ++a)
      for (int c = 0; c < np; ++c) {
        double s = 0;
        for (int b = 0; b < o.d; ++b) s += o.U[o.d * a + b] * J[(k * 6 + b) * np + c];
        UJ[a * np + c] = s;
      }
    for (int a = 0; a < o.d; ++a)
      for (int r = 0; r < np; ++r) {
        (*g)[r] += UJ[a * np + r] * z[a];
        for (int c = 0; c <= r; ++c) (*N)[r * np + c] += UJ[a * np + r] * UJ[a * np + c];
      }
  }
  for (int r = 0; r < np; ++r)
    for (int c = r + 1; c < np; ++c) (*N)[r * np + c] = (*N)[c * np + r];
}
// Cholesky solve of the Jacobi-scaled system (A + mu diag A) x = b; false if not positive definite.
bool solve(const std::vector<double>& A, double mu, const std::vector<double>& b, int n, std::vector<double>* x) {
  // A parameter the data do not see (zero diagonal) gets a zero step.
  std::vector<double> D(n), L(n * n, 0.0);
  std::vector<bool> blind(n);
  for (int i = 0; i < n; ++i) {
    blind[i] = !(A[i * n + i] > 0);
    D[i] = blind[i] ? 1.0 : std::sqrt(A[i * n + i]);
  }
  for (int i = 0; i < n; ++i)
    for (int j = 0; j <= i; ++j) {
      double s = blind[i] || blind[j] ? (i == j ? 1.0 : 0.0) : A[i * n + j] / (D[i] * D[j]) + (i == j ? mu : 0.0);
      for (int k = 0; k < j; ++k) s -= L[i * n + k] * L[j * n + k];
      if (i == j) {
        if (!(s > 0)) return false;
        L[i * n + i] = std::sqrt(s);
      } else {
        L[i * n + j] = s / L[j * n + j];
      }
    }
  std::vector<double> y(n);
  for (int i = 0; i < n; ++i) {
    double s = blind[i] ? 0.0 : b[i] / D[i];
    for (int k = 0; k < i; ++k) s -= L[i * n + k] * y[k];
    y[i] = s / L[i * n + i];
  }
  x->assign(n, 0.0);
  for (int i = n - 1; i >= 0; --i) {
    double s = y[i];
    for (int k = i + 1; k < n; ++k) s -= L[k * n + i] * (*x)[k];
    (*x)[i] = s / L[i * n + i];
  }
  for (int i = 0; i < n; ++i) (*x)[i] /= D[i];
  return true;
}
// Inverse of a symmetric positive definite matrix through its scaled Cholesky factor.
bool inverse(const std::vector<double>& A, int n, std::vector<double>* inv) {
  inv->assign(n * n, 0.0);
  std::vector<double> e(n), col;
  for (int j = 0; j < n; ++j) {
    std::fill(e.begin(), e.end(), 0.0);
    e[j] = 1.0;
    if (!solve(A, 0.0, e, n, &col)) return false;
    for (int i = 0; i < n; ++i) (*inv)[i * n + j] = col[i];
  }
  return true;
}
// Eigenvalue extremes of the Jacobi-scaled matrix (cyclic Jacobi), for its condition number.
double condition(const std::vector<double>& A, int n) {
  std::vector<double> a(n * n);
  for (int i = 0; i < n; ++i)
    for (int j = 0; j < n; ++j) a[i * n + j] = A[i * n + j] / std::sqrt(A[i * n + i] * A[j * n + j]);
  for (int sweep = 0; sweep < 60; ++sweep) {
    double off = 0;
    for (int i = 0; i < n; ++i)
      for (int j = i + 1; j < n; ++j) off += a[i * n + j] * a[i * n + j];
    if (off < 1e-30) break;
    for (int p = 0; p < n; ++p)
      for (int q = p + 1; q < n; ++q) {
        if (std::fabs(a[p * n + q]) < 1e-300) continue;
        const double th = (a[q * n + q] - a[p * n + p]) / (2 * a[p * n + q]);
        const double t = (th >= 0 ? 1.0 : -1.0) / (std::fabs(th) + std::sqrt(th * th + 1));
        const double c = 1 / std::sqrt(t * t + 1), s = t * c;
        for (int k = 0; k < n; ++k) {
          const double akp = a[k * n + p], akq = a[k * n + q];
          a[k * n + p] = c * akp - s * akq;
          a[k * n + q] = s * akp + c * akq;
        }
        for (int k = 0; k < n; ++k) {
          const double apk = a[p * n + k], aqk = a[q * n + k];
          a[p * n + k] = c * apk - s * aqk;
          a[q * n + k] = s * apk + c * aqk;
        }
      }
  }
  double lo = INFINITY, hi = 0;
  for (int i = 0; i < n; ++i) { lo = std::min(lo, a[i * n + i]); hi = std::max(hi, a[i * n + i]); }
  return lo > 0 ? hi / lo : INFINITY;
}

struct LmResult {
  int iterations = 0;
  bool converged = false;
  std::string stop;
  double cost = 0;
};
LmResult levenberg_marquardt(const Problem& pr, const std::vector<Obs>& obs, double p[kMaxP], const FitOptions& o) {
  LmResult res;
  std::vector<std::array<double, 6>> x, xt;
  if (!evaluate(pr, p, obs, &x)) { res.stop = "SGP4 failed at the starting elements"; return res; }
  double cost = cost_of(obs, x);
  double mu = 0;
  std::vector<double> J, N, g, d;
  for (int it = 0; it < o.max_iter; ++it) {
    if (!jacobian(pr, p, obs, &J)) { res.stop = "SGP4 failed in the Jacobian"; res.cost = cost; return res; }
    normal(pr, obs, J, x, &N, &g);
    for (double& gi : g) gi = -gi;
    bool accepted = false;
    double trial[kMaxP], cost_new = cost;
    // Decrease the Gauss-Newton model predicts (g'N^-1 g): when no step lowers
    // the cost, a negligible prediction means a stationary point (converged).
    double predicted = -1;
    if (solve(N, 0.0, g, pr.np, &d)) {
      predicted = 0;
      for (int k = 0; k < pr.np; ++k) predicted += g[k] * d[k];
    }
    for (int tries = 0; tries < 16; ++tries) {
      if (solve(N, mu, g, pr.np, &d)) {
        std::copy(p, p + kMaxP, trial);
        for (int j = 0, col = 0; j < kMaxP; ++j)
          if (pr.active[j]) trial[j] += d[col++];
        if (evaluate(pr, trial, obs, &xt)) {
          cost_new = cost_of(obs, xt);
          if (cost_new < cost) { accepted = true; break; }
        }
      }
      mu = mu == 0 ? 1e-8 : mu * 10;
    }
    res.iterations = it + 1;
    if (!accepted) {
      // Stationary when the linear model predicts (almost) nothing more; at the
      // numerical floor of noise-free data it still predicts noise away, so
      // an absolute floor on the position RMS also counts.
      const double floor_fraction = 1e-6;
      const double ratio = predicted >= 0 && cost > 0 ? predicted / cost : -1;
      // Absolute floor: the unweighted position RMS at or below floorKm.
      double sum2 = 0;
      for (size_t k = 0; k < obs.size(); ++k)
        for (int a = 0; a < 3; ++a) sum2 += (x[k][a] - obs[k].s->r[a]) * (x[k][a] - obs[k].s->r[a]);
      const double rms = std::sqrt(sum2 / std::max<size_t>(1, obs.size()));
      res.converged = cost < 1e-24 || (ratio >= 0 && ratio <= floor_fraction) || rms <= o.floor_km;
      char why[240];
      std::snprintf(why, sizeof why,
                    "no step lowers the cost; predicted decrease %.3g of the cost (stationary when <= %.3g), position RMS %.3g km (floor %.3g)",
                    ratio, floor_fraction, rms, o.floor_km);
      res.stop = why;
      break;
    }
    const double rel = (cost - cost_new) / std::max(cost, 1e-300);
    const bool undamped = mu == 0;
    std::copy(trial, trial + kMaxP, p);
    x.swap(xt);
    cost = cost_new;
    mu = mu / 10 < 1e-12 ? 0 : mu / 10;
    // Only an undamped (Gauss-Newton) step is evidence of convergence: a small
    // decrease from a damped step can be slow progress along a curved valley.
    if (undamped && rel <= o.tolerance) {
      res.converged = true;
      res.stop = "relative cost decrease of a Gauss-Newton step <= tolerance";
      break;
    }
  }
  if (res.stop.empty()) res.stop = "maximum iterations";
  res.cost = cost;
  return res;
}

// Whitening of one state under the options; false when it cannot be weighted (excluded).
bool weight(const State& s, const FitOptions& o, double w, Obs* ob) {
  ob->d = o.use_velocity && s.has_v ? 6 : 3;
  std::fill(ob->U, ob->U + 36, 0.0);
  const double sw = std::sqrt(w);
  if (o.weighting == "covariance") {
    if (!s.has_cov) return false;
    const int d = ob->d;
    // C = L L', whitening U = L^-1.
    double L[36] = {}, Li[36] = {};
    for (int i = 0; i < d; ++i)
      for (int j = 0; j <= i; ++j) {
        double sum = s.cov[6 * i + j];
        for (int k = 0; k < j; ++k) sum -= L[d * i + k] * L[d * j + k];
        if (i == j) {
          if (!(sum > 0)) return false;
          L[d * i + i] = std::sqrt(sum);
        } else {
          L[d * i + j] = sum / L[d * j + j];
        }
      }
    for (int c = 0; c < d; ++c)
      for (int i = 0; i < d; ++i) {
        double sum = i == c ? 1.0 : 0.0;
        for (int k = 0; k < i; ++k) sum -= L[d * i + k] * Li[d * k + c];
        Li[d * i + c] = sum / L[d * i + i];
      }
    for (int i = 0; i < d * d; ++i) ob->U[i] = Li[i] * sw;
    return true;
  }
  if (o.weighting == "rtn") {
    if (!s.has_v) return false;
    double ax[3][3];
    rsw_rows(s.r, s.v, ax);
    for (int a = 0; a < 3; ++a)
      for (int b = 0; b < 3; ++b) ob->U[ob->d * a + b] = ax[a][b] / o.sigma_rtn[a] * sw;
  } else {
    for (int a = 0; a < 3; ++a) ob->U[ob->d * a + a] = sw;  // 1 km
  }
  if (ob->d == 6)
    for (int a = 3; a < 6; ++a) ob->U[6 * a + a] = sw / o.sigma_v;
  return true;
}

// Lagrange derivative of the positions at index k (up to 4 neighbours each side), km/s.
bool finite_velocity(const std::vector<const State*>& s, size_t k, double v[3]) {
  if (s.size() < 3) return false;
  const size_t lo = k >= 4 ? k - 4 : 0, hi = std::min(s.size() - 1, k + 4);
  if (hi - lo < 2) return false;
  for (int a = 0; a < 3; ++a) v[a] = 0;
  const double tk = 0;
  for (size_t i = lo; i <= hi; ++i) {
    // d/dt of the Lagrange basis l_i at t_k.
    const double ti = seconds_between(s[k]->t, s[i]->t);
    double dl = 0;
    if (i == k) {
      for (size_t m = lo; m <= hi; ++m)
        if (m != i) dl += 1.0 / (tk - seconds_between(s[k]->t, s[m]->t));
    } else {
      double prod = 1.0 / (ti - tk);
      for (size_t m = lo; m <= hi; ++m) {
        if (m == i || m == k) continue;
        const double tm = seconds_between(s[k]->t, s[m]->t);
        prod *= (tk - tm) / (ti - tm);
      }
      dl = prod;
    }
    for (int a = 0; a < 3; ++a) v[a] += dl * s[i]->r[a];
  }
  return std::isfinite(v[0]);
}

struct Apriori {
  bool found = false;
  ElementSet* set = nullptr;
};

// Osculating-to-mean start: correct the mean elements by the difference
// between the target state's osculating equinoctial elements and those of
// SGP4's own state at the same time, until the difference vanishes. It
// removes SGP4's periodic terms from the start (near the equator SDP4's
// lunisolar periodics alone move the inclination vector by ~1e-4 rad, enough
// to start in another basin of the cost).
void refine_start(double sgp4_epoch, double minutes, const double r[3], const double v[3], double p[kMaxP]) {
  double el[6], target[kMaxP];
  if (!osculating(r, v, el)) return;
  const double cl[kMaxP] = {el[0], el[1], el[2], el[3], el[4], el[5], p[6]};
  equinoctial(cl, target);
  // Position miss of SGP4's state at the seed time; the iterate with the
  // smallest miss is kept, so the start is never worse than the osculating one.
  auto miss = [&](const double q[kMaxP], double x[6]) -> double {
    sdnap::Sat rec;
    if (!init_rec(sgp4_epoch, q, rec) || !sgp4_at(rec, minutes, x)) return HUGE_VAL;
    return std::sqrt((x[0] - r[0]) * (x[0] - r[0]) + (x[1] - r[1]) * (x[1] - r[1]) + (x[2] - r[2]) * (x[2] - r[2]));
  };
  double cur[kMaxP], best[kMaxP], x[6];
  std::copy(p, p + kMaxP, cur);
  std::copy(p, p + kMaxP, best);
  double best_miss = miss(cur, x);
  for (int it = 0; it < 30 && std::isfinite(best_miss); ++it) {
    double me[6], model[kMaxP];
    if (!std::isfinite(miss(cur, x)) || !osculating(x, x + 3, me)) break;
    const double mc[kMaxP] = {me[0], me[1], me[2], me[3], me[4], me[5], p[6]};
    equinoctial(mc, model);
    for (int k = 0; k < 6; ++k) cur[k] += k == 5 ? std::remainder(target[5] - model[5], 2 * kPi) : target[k] - model[k];
    const double m = miss(cur, x);
    if (!std::isfinite(m)) break;
    if (m < best_miss) { best_miss = m; std::copy(cur, cur + kMaxP, best); }
    if (m < 1e-9) break;
  }
  std::copy(best, best + kMaxP, p);
}

// One weighted fit of SGP4 to `pts` (time-ordered, the whole fit span): the
// epoch from the points, the start, the growing stages, the final fit with B*
// when asked, and outlier rejection. Shared by the full-span fit and the
// half-split closure fit, so both are the same algorithm.
struct Core {
  std::string error;
  Problem pr{};
  double p[kMaxP] = {};
  LmResult fin;
  int iterations = 0;
  nlohmann::json stages = nlohmann::json::array();
  std::vector<Obs> obs;  // the fitted observations after rejection
  uint64_t used = 0, unweighted = 0, rejected = 0;
  Instant t0;
  double bstar0 = 0;
};
Core core_fit(const std::vector<const State*>& pts, const FitOptions& o, const Apriori& ap) {
  Core c;
  // Fit points: the span thinned to stepSeconds (statistics always use every point).
  std::vector<const State*> span;
  for (const State* s : pts) {
    if (o.step_s > 0 && !span.empty() && seconds_between(span.back()->t, s->t) < o.step_s - 1e-6) continue;
    span.push_back(s);
  }
  c.used = span.size();
  if (span.size() < 4) { c.error = "fewer than four ephemeris states to fit"; return c; }
  c.t0 = pts.front()->t;
  if (o.epoch_mode == "last") c.t0 = pts.back()->t;
  else if (o.epoch_mode == "middle") c.t0 = pts[pts.size() / 2]->t;
  else if (o.epoch_mode == "explicit") c.t0 = o.epoch;
  size_t ks = 0;
  for (size_t k = 1; k < span.size(); ++k)
    if (std::fabs(seconds_between(c.t0, span[k]->t)) < std::fabs(seconds_between(c.t0, span[ks]->t))) ks = k;
  double v0[3];
  if (span[ks]->has_v) std::copy(span[ks]->v, span[ks]->v + 3, v0);
  else if (!finite_velocity(span, ks, v0)) { c.error = "no velocity at the seed state and too few neighbours to estimate one"; return c; }
  c.pr.sgp4_epoch = static_cast<double>(c.t0.day) + kSgp4EpochFromUnixDays + c.t0.sec / 86400.0;
  c.bstar0 = o.bstar_given ? o.bstar : 0.0;
  if (o.bstar_source == "apriori" && !ap.found) { c.error = "bstar apriori requested and no a priori set given"; return c; }
  if (ap.found && (o.bstar_source == "apriori" || !o.bstar_given)) c.bstar0 = ap.set->el[6];
  double el[6];
  if (o.initial == "apriori") {
    if (!ap.found) { c.error = "initial apriori requested and no a priori set given"; return c; }
    double x[6];
    if (!propagate(*ap.set, seconds_between(ap.set->epoch, c.t0) / 60.0, x, x + 3)) { c.error = "a priori set failed at the epoch"; return c; }
    if (!osculating(x, x + 3, el)) { c.error = "a priori state is not elliptic"; return c; }
  } else {
    if (!osculating(span[ks]->r, v0, el)) { c.error = "seed state is not elliptic"; return c; }
    el[5] = wrap2pi(el[5] + el[0] * seconds_between(span[ks]->t, c.t0) / 60.0);
  }
  const double cl[kMaxP] = {el[0], el[1], el[2], el[3], el[4], el[5], c.bstar0};
  equinoctial(cl, c.p);
  double osc_start[kMaxP];
  std::copy(c.p, c.p + kMaxP, osc_start);
  if (o.initial != "apriori") refine_start(c.pr.sgp4_epoch, seconds_between(c.t0, span[ks]->t) / 60.0, span[ks]->r, v0, c.p);
  const Instant tref = o.towards_end ? pts.back()->t : pts.front()->t;
  std::vector<Obs> all;
  for (const State* s : span) {
    Obs ob;
    ob.s = s;
    ob.minutes = seconds_between(c.t0, s->t) / 60.0;
    const double w = o.half_life_h > 0 ? std::pow(2.0, -std::fabs(seconds_between(tref, s->t)) / (3600.0 * o.half_life_h)) : 1.0;
    if (!weight(*s, o, w, &ob)) { ++c.unweighted; continue; }
    all.push_back(ob);
  }
  if (all.size() < 4) { c.error = "fewer than four weighted states"; return c; }
  // Stages around the seed (one period, growing four-fold, B* held), then the
  // whole span with B* when asked.
  struct Attempt {
    double p[kMaxP];
    LmResult fin;
    int iterations = 0;
    nlohmann::json stages = nlohmann::json::array();
    std::string error;
  };
  auto attempt = [&](const double start[kMaxP], const char* label) {
    Attempt at;
    std::copy(start, start + kMaxP, at.p);
    double half = 2 * kPi / at.p[0] * 60.0 / 2;
    for (int stage = 0; stage < 12; ++stage) {
      std::vector<Obs> win;
      for (const Obs& ob : all)
        if (std::fabs(seconds_between(span[ks]->t, ob.s->t)) <= half) win.push_back(ob);
      if (win.size() == all.size()) break;
      if (win.size() >= 6) {
        Problem pw = c.pr;
        for (int j = 0; j < kMaxP; ++j) pw.active[j] = j < 6;
        pw.np = 6;
        FitOptions loose = o;
        loose.tolerance = std::max(o.tolerance, 1e-8);
        const LmResult r = levenberg_marquardt(pw, win, at.p, loose);
        at.iterations += r.iterations;
        at.stages.push_back({{"start", label}, {"halfWidthSeconds", half}, {"states", win.size()}, {"iterations", r.iterations}, {"stop", r.stop}});
        if (!r.converged && r.stop.rfind("SGP4", 0) == 0) { at.error = r.stop; return at; }
      }
      half *= 4;
    }
    Problem pf = c.pr;
    for (int j = 0; j < kMaxP; ++j) pf.active[j] = j < 6 || (j == 6 && o.fit_bstar);
    pf.np = o.fit_bstar ? 7 : 6;
    at.fin = levenberg_marquardt(pf, all, at.p, o);
    at.iterations += at.fin.iterations;
    at.stages.push_back({{"start", label}, {"halfWidthSeconds", nullptr}, {"states", all.size()}, {"iterations", at.fin.iterations}, {"stop", at.fin.stop}});
    return at;
  };
  for (int j = 0; j < kMaxP; ++j) c.pr.active[j] = j < 6 || (j == 6 && o.fit_bstar);
  c.pr.np = o.fit_bstar ? 7 : 6;
  if (all.size() * 3 < static_cast<size_t>(c.pr.np) + 1) { c.error = "too few states for the parameters"; return c; }
  Attempt best = attempt(c.p, o.initial == "apriori" ? "apriori" : "osculating-to-mean");
  // Near the equator (osculating inclination below 3 degrees) SDP4's cost has
  // several basins in the inclination vector (chi, psi): the fit also starts
  // from the osculating vector and from that vector scaled by 1/4, 1/2 and 1
  // and turned by 0, 90, 180 and 270 degrees (absolute 1e-5 and 5e-5 when it
  // is below 1e-6), and the lowest final cost is kept.
  if (o.initial != "apriori" && std::hypot(osc_start[3], osc_start[4]) < std::tan(1.5 * kDeg)) {
    std::vector<std::pair<std::string, std::array<double, kMaxP>>> starts;
    std::array<double, kMaxP> s0;
    std::copy(osc_start, osc_start + kMaxP, s0.begin());
    starts.emplace_back("osculating", s0);
    const double mag = std::hypot(osc_start[3], osc_start[4]), dir = std::atan2(osc_start[3], osc_start[4]);
    const std::vector<double> mags = mag > 1e-6 ? std::vector<double>{0.25 * mag, 0.5 * mag, mag} : std::vector<double>{1e-5, 5e-5};
    for (double m : mags)
      for (int q = 0; q < 4; ++q) {
        std::array<double, kMaxP> st;
        std::copy(c.p, c.p + kMaxP, st.begin());
        st[3] = m * std::sin(dir + q * kPi / 2);
        st[4] = m * std::cos(dir + q * kPi / 2);
        char label[64];
        std::snprintf(label, sizeof label, "inclination vector %.2g at %+d deg", m, q * 90);
        starts.emplace_back(label, st);
      }
    int iters = best.iterations;
    nlohmann::json stages = best.stages;
    for (auto& [label, st] : starts) {
      Attempt other = attempt(st.data(), label.c_str());
      iters += other.iterations;
      for (auto& sj : other.stages) stages.push_back(sj);
      const bool better = other.error.empty() && other.fin.converged &&
                          (!best.error.empty() || !best.fin.converged || other.fin.cost < best.fin.cost);
      if (better) best = other;
    }
    best.iterations = iters;
    best.stages = stages;
  }
  if (!best.error.empty()) { c.error = best.error; c.stages = best.stages; return c; }
  std::copy(best.p, best.p + kMaxP, c.p);
  c.fin = best.fin;
  c.iterations = best.iterations;
  c.stages = best.stages;
  for (int pass = 0; pass < 3 && o.reject_k > 0 && c.fin.converged; ++pass) {
    std::vector<std::array<double, 6>> x;
    if (!evaluate(c.pr, c.p, all, &x)) break;
    double s2 = 0;
    std::vector<double> d(all.size());
    for (size_t k = 0; k < all.size(); ++k) {
      double d2 = 0;
      for (int a = 0; a < 3; ++a) d2 += (x[k][a] - all[k].s->r[a]) * (x[k][a] - all[k].s->r[a]);
      d[k] = std::sqrt(d2);
      s2 += d2;
    }
    const double rms = std::sqrt(s2 / all.size());
    std::vector<Obs> keep;
    for (size_t k = 0; k < all.size(); ++k)
      if (d[k] <= o.reject_k * rms) keep.push_back(all[k]);
    if (keep.size() == all.size() || keep.size() < 8) break;
    c.rejected += all.size() - keep.size();
    all.swap(keep);
    c.fin = levenberg_marquardt(c.pr, all, c.p, o);
    c.iterations += c.fin.iterations;
    c.stages.push_back({{"halfWidthSeconds", nullptr}, {"states", all.size()}, {"iterations", c.fin.iterations}, {"stop", c.fin.stop}, {"rejection", pass + 1}});
  }
  c.obs = all;
  if (!c.fin.converged) c.error = "not converged: " + c.fin.stop;
  return c;
}

// Residual statistics of a fitted model over states (every state given).
Stats score(const Core& c, const std::vector<const State*>& pts, nlohmann::json* samples) {
  Stats st;
  sdnap::Sat rec;
  if (!init_rec(c.pr.sgp4_epoch, c.p, rec)) { st.failures = pts.size(); return st; }
  for (const State* s : pts) {
    double x[6];
    if (!sgp4_at(rec, seconds_between(c.t0, s->t) / 60.0, x)) { ++st.failures; continue; }
    st.add(*s, x);
    if (samples) {
      double e[3], ax[3][3];
      for (int a = 0; a < 3; ++a) e[a] = x[a] - s->r[a];
      rsw_rows(s->r, s->has_v ? s->v : x + 3, ax);
      samples->push_back({iso(s->t), ax[0][0] * e[0] + ax[0][1] * e[1] + ax[0][2] * e[2],
                          ax[1][0] * e[0] + ax[1][1] * e[1] + ax[1][2] * e[2], ax[2][0] * e[0] + ax[2][1] * e[1] + ax[2][2] * e[2]});
    }
  }
  return st;
}

nlohmann::json fit_one(uint32_t norad, Track& tr, const FitOptions& o, const Apriori& ap, std::vector<uint8_t>* omm_out) {
  nlohmann::json row{{"norad", norad}};
  if (!tr.name.empty() || !o.object_name.empty()) row["objectName"] = o.object_name.empty() ? tr.name : o.object_name;
  // Every state of the fit span (stream and window), time-ordered.
  std::vector<const State*> pts;
  for (const State& s : tr.states) {
    if (o.stream >= 0 && s.stream != static_cast<uint32_t>(o.stream)) continue;
    if (o.has_from && before(s.t, o.from)) continue;
    if (o.has_to && before(o.to, s.t)) continue;
    pts.push_back(&s);
  }
  Core c = core_fit(pts, o, ap);
  row["states"] = {{"inSpan", pts.size()}, {"fitted", c.used}, {"withoutWeights", c.unweighted}, {"rejected", c.rejected}};
  row["stages"] = c.stages;
  row["iterations"] = c.iterations;
  row["converged"] = c.error.empty();
  row["stop"] = c.fin.stop;
  row["criterion"] = "an undamped step lowers the weighted cost by a relative " + std::to_string(o.tolerance) + " or less, or no step lowers it at a stationary point (predicted decrease <= 1e-6 of the cost) or below the position floor (" + std::to_string(o.floor_km) + " km)";
  if (!c.error.empty()) { row["error"] = c.error; return row; }
  const Problem& pr = c.pr;
  const double* p = c.p;
  const Instant t0 = c.t0;
  double el[kMaxP];
  classical(p, el);
  // Exact statistics: every state of the span, no thinning, no rejection.
  nlohmann::json samples = nlohmann::json::array();
  const Stats st = score(c, pts, o.residuals ? &samples : nullptr);
  row["rms"] = st.json();
  if (o.residuals) row["residuals"] = samples;
  // Half-split closure: the same fit on the first half of the states by time,
  // scored on every state of the second half.
  if (o.closure) {
    nlohmann::json cj{{"definition", "fit the first floor(N/2) states of the span by time with the same settings; residuals of that fit on the remaining states"}};
    if (pts.size() < 16) {
      cj["error"] = "fewer than 16 states in the span";
    } else {
      const size_t h = pts.size() / 2;
      const std::vector<const State*> first(pts.begin(), pts.begin() + h), second(pts.begin() + h, pts.end());
      const Core ch = core_fit(first, o, ap);
      cj["splitEpoch"] = iso(second.front()->t);
      cj["fitStates"] = first.size();
      cj["iterations"] = ch.iterations;
      if (!ch.error.empty()) cj["error"] = ch.error;
      else cj["rms"] = score(ch, second, nullptr).json();
    }
    row["closure"] = cj;
  }
  size_t m = 0;
  for (const Obs& ob : c.obs) m += ob.d;
  row["weightedRms"] = std::sqrt(c.fin.cost / static_cast<double>(m));
  std::vector<double> J, N, g;
  std::vector<std::array<double, 6>> x;
  nlohmann::json cov{{"parameters", nlohmann::json::array()}};
  const bool scale = o.scale_cov_given ? o.scale_cov : o.weighting != "covariance";
  const double s2 = scale ? c.fin.cost / static_cast<double>(std::max<size_t>(1, m - pr.np)) : 1.0;
  std::vector<double> P;
  if (evaluate(pr, p, c.obs, &x) && jacobian(pr, p, c.obs, &J)) {
    normal(pr, c.obs, J, x, &N, &g);
    row["conditionNumber"] = condition(N, pr.np);
    if (inverse(N, pr.np, &P)) {
      for (double& v : P) v *= s2;
      for (int j = 0; j < kMaxP; ++j)
        if (pr.active[j]) cov["parameters"].push_back(kParamNames[j]);
      std::vector<double> lower;
      for (int a = 0; a < pr.np; ++a)
        for (int b = 0; b <= a; ++b) lower.push_back(P[a * pr.np + b]);
      cov["equinoctial"] = lower;
      cov["scale"] = s2;
      const double e = el[1], t = std::tan(el[2] / 2);
      if (e > 1e-12 && t > 1e-12) {
        double C[kMaxP][kMaxP] = {};
        const double af = p[1], ag = p[2], chi = p[3], psi = p[4];
        const double rad = 180.0 / kPi;
        C[0][0] = 1440.0 / (2 * kPi);
        C[1][1] = af / e; C[1][2] = ag / e;
        const double di = 2.0 / (1 + t * t);
        C[2][3] = di * chi / t * rad; C[2][4] = di * psi / t * rad;
        C[3][3] = psi / (t * t) * rad; C[3][4] = -chi / (t * t) * rad;
        const double dvaf = -ag / (e * e), dvag = af / (e * e);
        C[4][1] = dvaf * rad; C[4][2] = dvag * rad; C[4][3] = -C[3][3]; C[4][4] = -C[3][4];
        C[5][1] = -dvaf * rad; C[5][2] = -dvag * rad; C[5][5] = rad;
        C[6][6] = 1;
        std::vector<int> idx;
        for (int j = 0; j < kMaxP; ++j)
          if (pr.active[j]) idx.push_back(j);
        const int rows = o.fit_bstar ? 7 : 6;
        std::vector<double> clv;
        for (int a = 0; a < rows; ++a)
          for (int b = 0; b <= a; ++b) {
            double sum = 0;
            for (int u = 0; u < pr.np; ++u)
              for (int w = 0; w < pr.np; ++w) sum += C[a][idx[u]] * P[u * pr.np + w] * C[b][idx[w]];
            clv.push_back(sum);
          }
        cov["classical"] = clv;
        cov["classicalUnits"] = "n rev/day; e; i, RAAN, argument of perigee, mean anomaly in degrees; B* 1/earth radii";
      } else {
        cov["classical"] = nullptr;
      }
    }
  }
  std::vector<double> rsw21;
  double x0[6];
  sdnap::Sat r0;
  if (!P.empty() && init_rec(pr.sgp4_epoch, p, r0) && sgp4_at(r0, 0.0, x0)) {
    std::vector<double> Jx(6 * pr.np);
    bool ok = true;
    for (int j = 0, col = 0; j < kMaxP && ok; ++j) {
      if (!pr.active[j]) continue;
      const double hh = step_of(j, p);
      double pp[kMaxP], pm[kMaxP], xp[6], xm[6];
      std::copy(p, p + kMaxP, pp);
      std::copy(p, p + kMaxP, pm);
      pp[j] += hh;
      pm[j] -= hh;
      sdnap::Sat a, b;
      ok = init_rec(pr.sgp4_epoch, pp, a) && init_rec(pr.sgp4_epoch, pm, b) && sgp4_at(a, 0.0, xp) && sgp4_at(b, 0.0, xm);
      for (int k = 0; k < 6 && ok; ++k) Jx[k * pr.np + col] = (xp[k] - xm[k]) / (2 * hh);
      ++col;
    }
    if (ok) {
      double ax[3][3];
      rsw_rows(x0, x0 + 3, ax);
      double B[6][6] = {};
      for (int blk = 0; blk < 2; ++blk)
        for (int i = 0; i < 3; ++i)
          for (int k = 0; k < 3; ++k) B[3 * blk + i][3 * blk + k] = ax[i][k];
      double BJ[6][kMaxP] = {};
      for (int i = 0; i < 6; ++i)
        for (int k2 = 0; k2 < pr.np; ++k2)
          for (int k = 0; k < 6; ++k) BJ[i][k2] += B[i][k] * Jx[k * pr.np + k2];
      for (int a = 0; a < 6; ++a)
        for (int b = 0; b <= a; ++b) {
          double sum = 0;
          for (int u = 0; u < pr.np; ++u)
            for (int w = 0; w < pr.np; ++w) sum += BJ[a][u] * P[u * pr.np + w] * BJ[b][w];
          rsw21.push_back(sum);
        }
      cov["cartesianRsw"] = rsw21;
      cov["cartesianUnits"] = "km, km/s; RSW axes of the fitted SGP4 state at the epoch; CCSDS lower-triangle order";
    }
  }
  row["covariance"] = cov;
  const double n_rev_day = el[0] * 1440.0 / (2 * kPi);
  row["epoch"] = iso(t0);
  row["elements"] = {{"MEAN_MOTION", n_rev_day}, {"ECCENTRICITY", el[1]}, {"INCLINATION", el[2] / kDeg},
                     {"RA_OF_ASC_NODE", el[3] / kDeg}, {"ARG_OF_PERICENTER", el[4] / kDeg}, {"MEAN_ANOMALY", el[5] / kDeg},
                     {"BSTAR", el[6]}};
  row["equinoctial"] = {p[0], p[1], p[2], p[3], p[4], p[5], p[6]};
  row["bstar"] = {{"fitted", o.fit_bstar}, {"initial", c.bstar0}};
  flatbuffers::FlatBufferBuilder fbb(1024);
  const std::string name = o.object_name.empty() ? tr.name : o.object_name;
  const std::string id = o.object_id.empty() ? tr.id : o.object_id;
  char comment[256];
  std::snprintf(comment, sizeof comment, "SGP4 fit to %llu ephemeris states %s to %s; RMS %.6f km (3D)",
                static_cast<unsigned long long>(st.n), iso(st.first).c_str(), iso(st.last).c_str(), std::sqrt(st.sum2 / std::max<uint64_t>(1, st.n)));
  const auto o_name = name.empty() ? 0 : fbb.CreateString(name);
  const auto o_id = id.empty() ? 0 : fbb.CreateString(id);
  const auto o_epoch = fbb.CreateString(iso(t0));
  const auto o_center = fbb.CreateString("EARTH");
  const auto o_comment = fbb.CreateString(o.comment.empty() ? std::string(comment) : o.comment);
  const auto o_orig = o.originator.empty() ? 0 : fbb.CreateString(o.originator);
  const auto o_created = o.creation_date.empty() ? 0 : fbb.CreateString(o.creation_date);
  const auto o_class = o.classification.empty() ? 0 : fbb.CreateString(o.classification);
  const auto teme = CreateRFM(fbb, RFMUnion::CelestialFrameWrapper, CreateCelestialFrameWrapper(fbb, CelestialFrame::TEMEOFDATE).Union(), 0,
                              fbb.CreateString("TEME"));
  flatbuffers::Offset<RFM> rsw;
  flatbuffers::Offset<flatbuffers::Vector<double>> covv;
  if (rsw21.size() == 21) {
    rsw = CreateRFM(fbb, RFMUnion::OrbitFrameWrapper, CreateOrbitFrameWrapper(fbb, OrbitFrame::RSW_INERTIAL).Union(), 0, fbb.CreateString("RSW"));
    covv = fbb.CreateVector(rsw21);
  }
  OMMBuilder b(fbb);
  b.add_CCSDS_OMM_VERS(3.0);
  if (!o.creation_date.empty()) b.add_CREATION_DATE(o_created);
  if (!o.originator.empty()) b.add_ORIGINATOR(o_orig);
  if (!name.empty()) b.add_OBJECT_NAME(o_name);
  if (!id.empty()) b.add_OBJECT_ID(o_id);
  b.add_CENTER_NAME(o_center);
  b.add_REFERENCE_FRAME(teme);
  b.add_TIME_SYSTEM(timingStandard::UTC);
  b.add_MEAN_ELEMENT_THEORY(meanElementSource::SGP4);
  b.add_COMMENT(o_comment);
  b.add_EPOCH(o_epoch);
  b.add_MEAN_MOTION(n_rev_day);
  b.add_ECCENTRICITY(el[1]);
  b.add_INCLINATION(el[2] / kDeg);
  b.add_RA_OF_ASC_NODE(el[3] / kDeg);
  b.add_ARG_OF_PERICENTER(el[4] / kDeg);
  b.add_MEAN_ANOMALY(el[5] / kDeg);
  b.add_EPHEMERIS_TYPE(ephemerisFormat::SGP4);
  if (!o.classification.empty()) b.add_CLASSIFICATION_TYPE(o_class);
  b.add_NORAD_CAT_ID(norad);
  if (o.element_set_no >= 0) b.add_ELEMENT_SET_NO(static_cast<uint32_t>(o.element_set_no));
  b.add_BSTAR(el[6]);
  b.add_MEAN_MOTION_DOT(0.0);
  b.add_MEAN_MOTION_DDOT(0.0);
  if (rsw21.size() == 21) {
    b.add_COV_REFERENCE_FRAME(rsw);
    b.add_COVARIANCE(covv);
  }
  FinishSizePrefixedOMMBuffer(fbb, b.Finish());
  omm_out->insert(omm_out->end(), fbb.GetBufferPointer(), fbb.GetBufferPointer() + fbb.GetSize());
  return row;
}

}  // namespace omfit

extern "C" int fit_elements() {
  using namespace omfit;
  const nlohmann::json opt = json_input("options");
  if (!opt.is_discarded() && !opt.is_object()) return fail("invalid-options", "options must be an $ERM ELEMENT_FITS record with OPTIONS.");
  FitOptions base;
  std::string e = read_fit_options(opt.is_object() ? opt : nlohmann::json::object(), &base);
  if (!e.empty()) return fail("invalid-options", e);
  Tracks tracks;
  LoadCounts lc;
  if (!(e = load_tracks(&tracks, &lc)).empty()) return fail("invalid-ephemeris", e);
  Options defaults;
  default_options(&defaults);
  Counts counts;
  std::vector<ElementSet> apriori;
  if (!load_elements(defaults, apriori, counts)) return fail("invalid-elements", error_text);
  // Requests: options.fits, or every object of the ephemeris with the base options.
  std::vector<std::pair<uint32_t, FitOptions>> requests;
  if (opt.is_object() && opt.contains("fits")) {
    if (!opt["fits"].is_array()) return fail("invalid-options", "fits is an array.");
    for (const auto& f : opt["fits"]) {
      if (!f.is_object() || !f.contains("norad") || !f["norad"].is_number_unsigned())
        return fail("invalid-options", "each fit needs norad.");
      FitOptions o = base;
      if (!(e = read_fit_options(f, &o)).empty()) return fail("invalid-options", e);
      requests.emplace_back(f["norad"].get<uint32_t>(), o);
    }
  } else {
    for (const auto& [norad, tr] : tracks) requests.emplace_back(norad, base);
  }
  std::vector<uint8_t> omms;
  nlohmann::json fits = nlohmann::json::array();
  uint64_t fitted = 0, failed = 0;
  for (auto& [norad, o] : requests) {
    auto it = tracks.find(norad);
    if (it == tracks.end()) {
      fits.push_back({{"norad", norad}, {"error", "no ephemeris states for this object"}});
      ++failed;
      continue;
    }
    Apriori ap;
    // The a priori set: the object's set nearest the fit epoch (or the latest).
    for (ElementSet& s : apriori)
      if (s.norad == norad && (!ap.found || before(ap.set->epoch, s.epoch))) { ap.set = &s; ap.found = true; }
    nlohmann::json row = fit_one(norad, it->second, o, ap, &omms);
    if (row.contains("error")) ++failed; else ++fitted;
    fits.push_back(row);
  }
  if (!omms.empty() &&
      plugin_push_output_ex("elements", "OMM.fbs", "$OMM", PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, "OMM", 0, 0, omms.data(),
                            static_cast<uint32_t>(omms.size())) < 0)
    return fail("output", "could not emit the fitted $OMM records.");
  nlohmann::json frames = nlohmann::json::object();
  for (const auto& [k, v] : lc.frames) frames[k] = v;
  return emit("report", {{"kind", "element-fit"}, {"version", 1},
                         {"model", "SGP4 (foundation/sgp4-str3, Spacetrack Report No. 3), WGS-72, improved mode; TEME"},
                         {"residualSign", "model minus ephemeris"},
                         {"units", "km, km/s; rmsPerCoordinateKm = rms3dKm / sqrt(3)"},
                         {"counts", {{"streams", lc.streams}, {"blocks", lc.blocks}, {"states", lc.states}, {"duplicateEpochs", lc.duplicates},
                                     {"covariances", lc.covariances}, {"frames", frames}, {"aprioriSets", apriori.size()},
                                     {"fitted", fitted}, {"failed", failed}}},
                         {"fits", fits}});
}

extern "C" int element_residuals() {
  using namespace omfit;
  const nlohmann::json opt = json_input("options");
  if (!opt.is_object() || !opt.contains("requests") || !opt["requests"].is_array())
    return fail("invalid-options", "options must be an $ERM ELEMENT_FITS record with RESIDUAL_REQUESTS.");
  const bool want_samples = opt.value("samples", false);
  Options defaults;
  default_options(&defaults);
  Counts counts;
  std::vector<ElementSet> sets;
  if (!load_elements(defaults, sets, counts)) return fail("invalid-elements", error_text);
  Tracks tracks;
  LoadCounts lc;
  std::string e = load_tracks(&tracks, &lc);
  if (!e.empty()) return fail("invalid-ephemeris", e);
  nlohmann::json results = nlohmann::json::array();
  for (const auto& req : opt["requests"]) {
    if (!req.is_object() || !req.contains("norad") || !req["norad"].is_number_unsigned() || !req.contains("set") ||
        !req["set"].is_string() || !req.contains("windows") || !req["windows"].is_array())
      return fail("invalid-options", "each request needs norad, set and windows.");
    const uint32_t norad = req["norad"].get<uint32_t>();
    Instant set_epoch;
    if (!parse_instant(req["set"].get<std::string>(), &set_epoch)) return fail("invalid-options", "set is not ISO 8601 UTC.");
    int stream = -1;
    if (req.contains("ephemerisStream")) {
      if (!req["ephemerisStream"].is_number_unsigned()) return fail("invalid-options", "ephemerisStream is a stream index.");
      stream = req["ephemerisStream"].get<int>();
    }
    const double step = req.value("stepSeconds", 0.0);
    nlohmann::json row{{"norad", norad}, {"set", req["set"]}};
    if (req.contains("label")) row["label"] = req["label"];
    ElementSet* s = common::find_set(sets, norad, set_epoch);
    auto tr = tracks.find(norad);
    if (!s) row["error"] = "element set not found";
    else if (tr == tracks.end()) row["error"] = "no ephemeris states for this object";
    if (row.contains("error")) { results.push_back(row); continue; }
    nlohmann::json windows = nlohmann::json::array();
    for (const auto& w : req["windows"]) {
      Instant from, to;
      if (!w.is_object() || !w.contains("from") || !w.contains("to") || !w["from"].is_string() || !w["to"].is_string() ||
          !parse_instant(w["from"].get<std::string>(), &from) || !parse_instant(w["to"].get<std::string>(), &to))
        return fail("invalid-options", "each window needs from and to (ISO 8601 UTC).");
      Stats st;
      nlohmann::json samples = nlohmann::json::array();
      const State* last = nullptr;
      for (const State& x : tr->second.states) {
        if (stream >= 0 && x.stream != static_cast<uint32_t>(stream)) continue;
        if (before(x.t, from) || before(to, x.t)) continue;
        if (step > 0 && last && seconds_between(last->t, x.t) < step - 1e-6) continue;
        last = &x;
        double m[6];
        if (!propagate(*s, seconds_between(s->epoch, x.t) / 60.0, m, m + 3)) { ++st.failures; continue; }
        st.add(x, m);
        if (want_samples) {
          double d[3], ax[3][3];
          for (int a = 0; a < 3; ++a) d[a] = m[a] - x.r[a];
          rsw_rows(x.r, x.has_v ? x.v : m + 3, ax);
          samples.push_back({iso(x.t), ax[0][0] * d[0] + ax[0][1] * d[1] + ax[0][2] * d[2],
                             ax[1][0] * d[0] + ax[1][1] * d[1] + ax[1][2] * d[2], ax[2][0] * d[0] + ax[2][1] * d[1] + ax[2][2] * d[2]});
        }
      }
      nlohmann::json out = st.json();
      out["from"] = w["from"];
      out["to"] = w["to"];
      if (w.contains("label")) out["label"] = w["label"];
      if (want_samples) out["samples"] = samples;
      windows.push_back(out);
    }
    row["windows"] = windows;
    results.push_back(row);
  }
  return emit("residuals", {{"kind", "element-residuals"}, {"version", 1},
                            {"model", "SGP4 (foundation/sgp4-str3, Spacetrack Report No. 3), WGS-72, improved mode; TEME"},
                            {"residualSign", "prediction minus ephemeris"},
                            {"units", "km, km/s; rmsPerCoordinateKm = rms3dKm / sqrt(3)"},
                            {"counts", {{"elementSets", counts.records}, {"refused", counts.refused}, {"states", lc.states},
                                        {"duplicateEpochs", lc.duplicates}}},
                            {"results", results}});
}
