// -----------------------------------------------------------------------------
// The carried forecast (SPEC 18). An $OCM element set may carry a numerical
// forecast of its object: Chebyshev position segments in
// POLYNOMIAL_POSITION_RECORDS (PPE, BASIS_TYPE CHEBYSHEV, positions only),
// TRAJ_TYPE POLYNOMIAL_POS, TRAJ_BASIS PREDICTED, in the set's own
// TRAJ_REF_FRAME. Inside the span the segments cover (the first's start to the
// last's end, both included) flight returns the forecast, velocity by
// differentiation; everywhere else the theory, exactly as without them.
//   - frame: TEMEOFEPOCH sets carry the forecast in their epoch axes Q0 GCRF
//     (an inertial frame); flight turns it to TEME of date by M(t) Q0^T, M the
//     module's output matrix GCRF -> TEME (gcrf.inc gcrf_to_teme_output: the
//     quintic through 6-hour nodes every GCRF state takes). TEMEOFDATE sets
//     carry TEME of date; the velocity flown is the derivative less the frame's
//     own turning, dM/dt M^T r, so both kinds return the module's TEME
//     convention (the GCRF velocity turned by M). No ERFA call per state.
//   - fit (OUTPUT.START_TIME to STOP_TIME on fit's $PCF) builds the segments
//     from the block's states: densified 4x by the 4-node Hermite of their
//     positions and velocities (by the 8-node Lagrange of the positions when
//     a state has no velocity), then the longest least-squares segments within
//     kToleranceKm in position and kVelocityToleranceKmS in velocity of every
//     densified point and of the interpolant halfway between two (velocity
//     rows weighted by the ratio of the two bounds), the coefficient count of
//     16, 24, 32, 48 or 64 that writes the fewest bytes.
//   - the span's end: fit fits the theory to the forecast's last part (its arc
//     ends at OUTPUT.STOP_TIME; the states after it are held out), so the
//     theory takes over where the forecast stops (fit_oem.inc).
// -----------------------------------------------------------------------------

namespace sdnap {
namespace carried {

/// A segment's position bound against the densified forecast, km (5 mm: half the 1 cm the record is held to against the
/// forecast at any time, the input's interpolant taking the rest). Measured on FFM forecasts at 30 s: the velocity bound
/// below sets the segments' length in low orbit (the same bytes at 1 and 10 cm); at 1 cm medium and geosynchronous
/// records take 1.3 and 0.7 kB a day where 10 cm takes 0.8 and 0.4.
constexpr double kToleranceKm = 5.0e-6;
/// A segment's velocity bound against the densified forecast, km/s (0.05 mm/s, half the 0.1 mm/s the record is held to
/// against the forecast at any time: the input's interpolant and the series between checked points take the rest).
constexpr double kVelocityToleranceKmS = 5.0e-8;
/// The velocity bound when the forecast's velocities are not its positions' derivative (built from the positions: the
/// 8-node Lagrange's derivative is the velocity checked against), km/s (1 mm/s). Measured, that derivative between FFM
/// states 30 s apart misses the forecast by up to 0.04 mm/s and steps by up to 0.12 mm/s where two windows meet (300
/// km); an analytic theory's positions, its node interpolation not smooth in acceleration, hold no tighter bound.
constexpr double kPositionsOnlyVelocityKmS = 1.0e-6;
/// Densified points per state interval (the interpolant between consecutive states).
constexpr int kDensify = 4;
/// Coefficient counts fit tries, in ascending order; the record takes the fewest coefficients whose segments write at
/// most kBytesSlack more bytes than the fewest bytes any count writes (a state's cost grows with its coefficients: in
/// low orbit 64 write about 6 % fewer bytes than 32 at twice the arithmetic per state).
constexpr int kCandidates[] = {16, 24, 32, 48, 64};
constexpr double kBytesSlack = 0.10;
/// Most coefficients a record may carry per axis (reader's bound).
constexpr uint16_t kMaxCoefficients = 64;
/// The most arc (rad, about the Earth's center) between consecutive states a forecast is built from (30 s in low orbit
/// and at the perigee of an e 0.9 orbit at 500 km). Measured, the 4-node Hermite's velocity error between FFM states:
/// at most 0.002 mm/s at 30 s; at 60 s (0.066 to 0.07 rad in low orbit) 0.017 mm/s at 500 km and 0.075 at 300 km, too
/// much of the 0.1 mm/s bound; at 120 s 1.4 mm/s.
constexpr double kMaxArcRad = 0.05;
/// States whose velocities differ from their positions' 8-node Lagrange derivative by more than this in RMS (km/s: the
/// velocity bound, 0.05 mm/s) are built from their positions alone. Measured at the steps the arc bound allows: FFM's
/// states 0.0002 to 0.011 mm/s (the Lagrange derivative's own error mostly); an analytic theory's velocity is not its
/// position's derivative (SGP4 and SGP4XP by 20 to 70 mm/s in low orbit).
constexpr double kVelocityAgreementKmS = kVelocityToleranceKmS;
/// The weight of a segment's two end points in its least squares: consecutive segments share the end point, so they meet
/// in position and velocity (to about the tolerance over this weight squared).
constexpr double kJoinWeight = 1.0e4;
/// Consecutive segments meet within this, s.
constexpr double kJoinSeconds = 1.0e-3;
/// Half the step of dM/dt's central difference, days (60 s).
constexpr double kRateStepDays = 60.0 / 86400.0;

// ---- The frame: the module's output matrix (gcrf.inc gcrf_to_teme_output) ------------------------------------------

/// M (row-major 3 x 3), GCRF -> TEME of date at the split Julian date w + f (UTC): the output matrix every GCRF state of
/// the module takes (the quintic through 6-hour nodes, GMST82 unrounded, nodes held per thread; gcrf.inc), made
/// orthonormal (one Newton step of the polar decomposition, M (3 I - M^T M) / 2), so M^T inverts M exactly wherever the
/// forecast is turned back and forth; and dM/dt per second when `md` is given (the central difference over +-60 s).
/// False outside ERFA's calendar.
inline bool frame_at_uncached(double w, double f, double* M, double* md);
inline bool frame_at(double w, double f, double* M, double* md) {
  // the last matrix kept per thread: a store stepping many objects to one instant (sdnap_epochs_at) asks it of each
  struct Last {
    double w = std::numeric_limits<double>::quiet_NaN(), f = 0.0;
    bool rate = false;
    double M[9], md[9];
  };
  static thread_local Last last;
  if (w == last.w && f == last.f && (md == nullptr || last.rate)) {
    std::memcpy(M, last.M, sizeof last.M);
    if (md != nullptr) std::memcpy(md, last.md, sizeof last.md);
    return true;
  }
  const bool ok = frame_at_uncached(w, f, M, md);
  if (ok) {
    last.w = w;
    last.f = f;
    last.rate = md != nullptr;
    std::memcpy(last.M, M, sizeof last.M);
    if (md != nullptr) std::memcpy(last.md, md, sizeof last.md);
  }
  return ok;
}
inline bool frame_at_uncached(double w, double f, double* M, double* md) {
  double m[3][3];
  if (frames::gcrf_to_teme_output(w, f, m) < 0) return false;
  const double* c = &m[0][0];
  double g[9];
  for (int i = 0; i < 3; ++i)
    for (int j = 0; j < 3; ++j) g[3 * i + j] = (i == j ? 3.0 : 0.0) - (c[i] * c[j] + c[3 + i] * c[3 + j] + c[6 + i] * c[6 + j]);
  for (int i = 0; i < 3; ++i)
    for (int j = 0; j < 3; ++j) M[3 * i + j] = 0.5 * (c[3 * i] * g[j] + c[3 * i + 1] * g[3 + j] + c[3 * i + 2] * g[6 + j]);
  if (md != nullptr) {
    double a[3][3], b[3][3];
    if (frames::gcrf_to_teme_output(w, f + kRateStepDays, a) < 0 || frames::gcrf_to_teme_output(w, f - kRateStepDays, b) < 0) return false;
    for (int i = 0; i < 3; ++i)
      for (int j = 0; j < 3; ++j) md[3 * i + j] = (a[i][j] - b[i][j]) / (2.0 * kRateStepDays * 86400.0);
  }
  return true;
}

inline void mul(const double* M, const double* a, double* out) {
  for (int i = 0; i < 3; ++i) out[i] = M[3 * i] * a[0] + M[3 * i + 1] * a[1] + M[3 * i + 2] * a[2];
}
inline void mul_t(const double* M, const double* a, double* out) {
  for (int i = 0; i < 3; ++i) out[i] = M[i] * a[0] + M[3 + i] * a[1] + M[6 + i] * a[2];
}

/// Q0, the set's epoch axes (GCRF -> TEMEOFEPOCH): M at the epoch.
inline bool epoch_axes(double w, double f, double* q0) { return frame_at(w, f, q0, nullptr); }

// ---- The carried track of a record ---------------------------------------------------------------------------------
//
// Read lazily: loading a record reads its first and last segments (the span) and nothing else of its forecast; every
// other segment is verified (its table, by its own FlatBuffers verifier: the build leaves the PPE tables out of the
// $OCM verifier, build.mjs) and read when a state first needs it, then kept. A time inside the span is found by
// interpolation search over the segments' start times, each segment read as the search reaches it; a time the segment
// found does not cover (to kJoinSeconds) is a gap.

/// What reading a segment found: kRead, or the refusal (named by refusal_name).
enum SegmentState : int32_t { kUnread = 0, kTimed = 1, kRead = 2, kNotVerifiable = -1, kBasis = -2, kVelocity = -3, kInvalid = -4, kGap = -5, kFrame = -6 };

struct Segment {
  double start = 0.0, mid = 0.0, half = 0.0, inv_half = 0.0;  ///< seconds from the set's epoch
  uint32_t n = 0, off = 0;   ///< coefficients per axis; offset into Track::c (x then y then z)
  int32_t state = kUnread;   ///< kTimed: start, mid and half read; kRead: the coefficients too; < 0 refused
};

/// A record's carried forecast as flight reads it: empty when the record carries none. Movable, not copyable (`buf`
/// may point into `own`).
struct Track {
  int frame = 0;               ///< 1 TEMEOFDATE, 2 TEMEOFEPOCH
  double w = 0.0, f = 0.0;     ///< the set's epoch, split Julian date (UTC)
  double start = 0.0, stop = 0.0;  ///< the span, seconds from the epoch (closed)
  double q0[9] = {};           ///< TEMEOFEPOCH: GCRF -> the epoch axes
  std::vector<uint8_t> own;    ///< the record's bytes, when the track outlives the call that brought them (the store)
  const uint8_t* buf = nullptr;  ///< the bytes the segments are read from: own's, or the caller's for the call
  size_t size = 0;
  const flatbuffers::Vector<flatbuffers::Offset<PPEPositionRecord>>* recs = nullptr;
  std::vector<Segment> segs;   ///< one per record, read on first use
  std::vector<double> c;       ///< the coefficients of the segments read so far
  uint32_t hint = 0;           ///< the segment last flown
  Track() = default;
  Track(const Track&) = delete;
  Track& operator=(const Track&) = delete;
  Track(Track&&) = default;
  Track& operator=(Track&&) = default;
  bool empty() const { return segs.empty(); }
  bool covers(double t) const { return !segs.empty() && t >= start && t <= stop; }
  size_t bytes() const { return sizeof(Track) + own.capacity() + segs.capacity() * sizeof(Segment) + c.capacity() * sizeof(double); }
};

/// The refusal code and text of a segment's state.
inline const char* refusal_name(int32_t s) {
  switch (s) {
    case kBasis: return "carried-basis-unsupported";
    case kVelocity: return "carried-velocity-coefficients";
    case kGap: return "carried-gap";
    case kFrame: return "frame-failed";
    default: return "carried-segment-invalid";
  }
}
inline const char* refusal_text(int32_t s) {
  switch (s) {
    case kBasis: return "A carried segment is a Chebyshev series (BASIS_TYPE CHEBYSHEV).";
    case kVelocity: return "A carried segment states positions only: its velocity is the series' derivative.";
    case kGap: return "Carried segments follow one another, each starting where the one before ends (within 1 ms): a time inside the span falls between two.";
    case kFrame: return "No GCRF axes at the time (outside ERFA's calendar).";
    case kNotVerifiable: return "A carried segment (PPEPositionRecord) does not verify.";
    default: return "A carried segment states its EPOCH_MID (ISO 8601 UTC), a positive EPOCH_HALF_SPAN and NUM_COEFFICIENTS (1 to 64) finite coefficients per axis.";
  }
}

/// Seconds from (w, f) of an ISO 8601 UTC text, or false.
inline bool seconds_of(const flatbuffers::String* s, double w, double f, double& out) {
  double tw, tf;
  if (s == nullptr || !omm::epoch(s->c_str(), s->size(), tw, tf)) return false;
  out = ((tw - w) + (tf - f)) * 86400.0;
  return true;
}

/// Segment k of t read to `want` (kTimed: its table verified, EPOCH_MID and EPOCH_HALF_SPAN; kRead: its basis, its
/// coefficients checked and kept). Its state: kTimed or kRead, or the refusal (kept: a segment is judged once).
inline int32_t ensure(Track& t, uint32_t k, int32_t want) {
  Segment& s = t.segs[k];
  if (s.state < 0 || s.state >= want) return s.state;
  const PPEPositionRecord* p = t.recs->Get(k);
  if (s.state == kUnread) {
    flatbuffers::Verifier::Options vopt;
    vopt.check_alignment = false;
    flatbuffers::Verifier v(t.buf, t.size, vopt);
    if (!p->Verify(v)) return s.state = kNotVerifiable;
    const double half = p->EPOCH_HALF_SPAN();
    if (!seconds_of(p->EPOCH_MID(), t.w, t.f, s.mid) || !(half > 0.0) || !std::isfinite(half)) return s.state = kInvalid;
    s.half = half;
    s.inv_half = 1.0 / half;
    s.start = s.mid - half;
    s.state = kTimed;
    if (want == kTimed) return s.state;
  }
  if (p->BASIS_TYPE() != polynomialBasisType_CHEBYSHEV) return s.state = kBasis;
  if (p->HAS_VELOCITY_COEFFICIENTS() || (p->VEL_COEFF_X() != nullptr && p->VEL_COEFF_X()->size() > 0) ||
      (p->VEL_COEFF_Y() != nullptr && p->VEL_COEFF_Y()->size() > 0) || (p->VEL_COEFF_Z() != nullptr && p->VEL_COEFF_Z()->size() > 0))
    return s.state = kVelocity;
  const uint16_t n = p->NUM_COEFFICIENTS();
  const auto *x = p->POS_COEFF_X(), *y = p->POS_COEFF_Y(), *z = p->POS_COEFF_Z();
  if (n < 1 || n > kMaxCoefficients || x == nullptr || y == nullptr || z == nullptr || x->size() != n || y->size() != n || z->size() != n)
    return s.state = kInvalid;
  s.n = n;
  s.off = static_cast<uint32_t>(t.c.size());
  t.c.resize(t.c.size() + 3u * n);
  double* dst = t.c.data() + s.off;
  for (const auto* v : {x, y, z}) {
    std::memcpy(dst, v->data(), sizeof(double) * n);  // little-endian doubles, as the wire holds them
    dst += n;
  }
  double check = 0.0;
  for (uint32_t j = 0; j < 3u * n; ++j) check += t.c[s.off + j] * 0.0;  // NaN or infinity leave a NaN
  if (check != 0.0) {
    t.c.resize(s.off);
    return s.state = kInvalid;
  }
  return s.state = kRead;
}

/// A track's bytes copied into it (a track that outlives the call whose bytes it reads: the store's), the record's
/// vector found again in the copy at its offset.
inline void keep(Track& t) {
  if (t.empty() || (!t.own.empty() && t.buf == t.own.data())) return;
  const size_t at = reinterpret_cast<const uint8_t*>(t.recs) - t.buf;
  t.own.assign(t.buf, t.buf + t.size);
  t.buf = t.own.data();
  t.recs = reinterpret_cast<const flatbuffers::Vector<flatbuffers::Offset<PPEPositionRecord>>*>(t.buf + at);
}

/// The carried forecast of a decoded record (`row` its set; `p`, `n` the bytes it lives in, read in place: keep() copies
/// them for a track that outlives the call): 0 with `t` filled (empty when the record carries none), or 3 refused by
/// name. The first and last segments are read (the span). ocm::decode has checked the frame pairing.
inline int read(const OCM* o, const ElementRow& row, const uint8_t* p, size_t n, Track& t) {
  t = Track{};
  if (o == nullptr) return 0;
  if (o->POLYNOMIAL_OE_RECORDS() != nullptr && o->POLYNOMIAL_OE_RECORDS()->size() > 0)
    return ocm::refuse("carried-type-unsupported", "POLYNOMIAL_OE_RECORDS are not flown: a carried forecast is POLYNOMIAL_POSITION_RECORDS.");
  const auto* recs = o->POLYNOMIAL_POSITION_RECORDS();
  const bool any = recs != nullptr && recs->size() > 0;
  if (!any) {
    if (o->TRAJ_TYPE() == trajectoryType_POLYNOMIAL_POS)
      return ocm::refuse("carried-records-missing", "TRAJ_TYPE POLYNOMIAL_POS with no POLYNOMIAL_POSITION_RECORDS.");
    return 0;
  }
  if (o->TRAJ_TYPE() != trajectoryType_POLYNOMIAL_POS)
    return ocm::refuse("carried-type-mismatch", "POLYNOMIAL_POSITION_RECORDS beside an element set state TRAJ_TYPE POLYNOMIAL_POS.");
  if (o->STATE_DATA() != nullptr && o->STATE_DATA()->size() > 0)
    return ocm::refuse("carried-state-data", "An element set carries no STATE_DATA: its forecast is POLYNOMIAL_POSITION_RECORDS.");
  t.frame = ocm::frame_kind(o->TRAJ_REF_FRAME());
  if (t.frame != 1 && t.frame != 2) return ocm::refuse("frame-pairing-invalid", "A carried forecast is in the set's TRAJ_REF_FRAME, TEMEOFDATE or TEMEOFEPOCH.");
  t.w = row.epoch_jd_whole;
  t.f = row.epoch_jd_frac;
  t.buf = p;
  t.recs = recs;
  t.size = n;
  t.segs.resize(recs->size());
  const uint32_t last = recs->size() - 1;
  for (const uint32_t k : {0u, last}) {
    const int32_t s = ensure(t, k, kRead);
    if (s < 0) return ocm::refuse(refusal_name(s), refusal_text(s));
  }
  t.start = t.segs.front().start;
  t.stop = t.segs.back().mid + t.segs.back().half;
  if (!(t.stop > t.start)) return ocm::refuse("carried-segment-invalid", "A carried forecast's last segment ends after its first starts.");
  if (t.frame == 2 && !epoch_axes(t.w, t.f, t.q0)) return ocm::refuse("frame-failed", "No GCRF axes at the set's epoch (outside ERFA's calendar).");
  return 0;
}

/// The segment holding t (seconds from the epoch, inside the span), read: its index, or the refusal (< 0). The
/// segment last flown and its successor first, then interpolation search over the start times, each segment read as
/// the search reaches it.
inline int64_t segment_at(Track& tr, double t) {
  const uint32_t count = static_cast<uint32_t>(tr.segs.size());
  auto inside = [&](uint32_t k) {
    const Segment& s = tr.segs[k];
    return s.state > 0 && t >= s.start - kJoinSeconds && t <= s.mid + s.half + kJoinSeconds;
  };
  for (uint32_t k = tr.hint; k < count && k <= tr.hint + 1; ++k) {
    if (ensure(tr, k, kTimed) < 0) break;
    if (inside(k) && (k + 1 >= count || ensure(tr, k + 1, kTimed) < 0 || tr.segs[k + 1].start > t)) {
      const int32_t s = ensure(tr, k, kRead);
      if (s < 0) return s;
      tr.hint = k;
      return k;
    }
  }
  // lo: a segment starting at or before t; hi: one starting after it (count: the span's end)
  uint32_t lo = 0, hi = count;
  double tlo = tr.start, thi = tr.stop;
  while (hi - lo > 1) {
    double g = (t - tlo) / (thi - tlo) * static_cast<double>(hi - lo);
    uint32_t mid = lo + static_cast<uint32_t>(std::fmin(std::fmax(g, 1.0), static_cast<double>(hi - lo - 1)));
    if (const int32_t s = ensure(tr, mid, kTimed); s < 0) return s;
    if (tr.segs[mid].start <= t) {
      lo = mid;
      tlo = tr.segs[mid].start;
    } else {
      hi = mid;
      thi = tr.segs[mid].start;
    }
  }
  if (const int32_t s = ensure(tr, lo, kRead); s < 0) return s;
  if (!inside(lo)) return kGap;
  tr.hint = lo;
  return lo;
}

/// The series of segment s at time t (seconds from the epoch): position p (km) and its derivative pd (km/s).
inline void series(const Track& tr, const Segment& s, double t, double p[3], double pd[3]) {
  const double tau = (t - s.mid) * s.inv_half;
  const uint32_t n = s.n;
  const double* c = tr.c.data() + s.off;
  double T[kMaxCoefficients], D[kMaxCoefficients];
  T[0] = 1.0;
  D[0] = 0.0;
  if (n > 1) {
    T[1] = tau;
    D[1] = 1.0;
  }
  for (uint32_t k = 2; k < n; ++k) {
    T[k] = 2.0 * tau * T[k - 1] - T[k - 2];
    D[k] = 2.0 * T[k - 1] + 2.0 * tau * D[k - 1] - D[k - 2];
  }
  for (int a = 0; a < 3; ++a) {
    const double* ca = c + a * n;
    double sp = 0.0, sd = 0.0;
    for (uint32_t k = 0; k < n; ++k) {
      sp += ca[k] * T[k];
      sd += ca[k] * D[k];
    }
    p[a] = sp;
    pd[a] = sd * s.inv_half;
  }
}

/// The carried state at t (seconds from the set's epoch, inside the span) in TEME of date (km, km/s): 0, or the
/// segment's refusal (SegmentState < 0; kFrame outside ERFA's calendar). `jd`, the split Julian date of t when the
/// caller has it, times the frame (a store stepping many objects to one instant computes M once: frame_at keeps it).
inline int32_t at(Track& tr, double t, double r[3], double v[3], const double* jd = nullptr) {
  const int64_t k = segment_at(tr, t);
  if (k < 0) return static_cast<int32_t>(k);
  double p[3], pd[3], M[9];
  series(tr, tr.segs[static_cast<size_t>(k)], t, p, pd);
  const double fw = jd != nullptr ? jd[0] : tr.w, ff = jd != nullptr ? jd[1] : tr.f + t / 86400.0;
  if (tr.frame == 2) {
    double g[3], gv[3];
    mul_t(tr.q0, p, g);
    mul_t(tr.q0, pd, gv);
    if (!frame_at(fw, ff, M, nullptr)) return kFrame;
    mul(M, g, r);
    mul(M, gv, v);
    return 0;
  }
  double md[9], u[3], w[3];
  if (!frame_at(fw, ff, M, md)) return kFrame;
  mul_t(M, p, u);
  mul(md, u, w);
  for (int a = 0; a < 3; ++a) {
    r[a] = p[a];
    v[a] = pd[a] - w[a];
  }
  return 0;
}

/// The carried state at t in GCRF (km, km/s) without a per-state ERFA call: TEMEOFEPOCH Q0^T exactly; TEMEOFDATE M^T by
/// the cubic, the inverse of what fit wrote (the GCRF input itself, to the series). 0, or the refusal as at().
inline int32_t at_gcrf(Track& tr, double t, double r[3], double v[3]) {
  const int64_t k = segment_at(tr, t);
  if (k < 0) return static_cast<int32_t>(k);
  double p[3], pd[3];
  series(tr, tr.segs[static_cast<size_t>(k)], t, p, pd);
  if (tr.frame == 2) {
    mul_t(tr.q0, p, r);
    mul_t(tr.q0, pd, v);
    return 0;
  }
  double M[9], md[9], w[3], u[3];
  if (!frame_at(tr.w, tr.f + t / 86400.0, M, md)) return kFrame;
  mul_t(M, p, r);  // r_G = M^T p
  mul(md, r, w);   // p' = M v_G + dM/dt r_G
  for (int a = 0; a < 3; ++a) u[a] = pd[a] - w[a];
  mul_t(M, u, v);
  return 0;
}

// ---- fit: the segments of a forecast -------------------------------------------------------------------------------

struct Point {
  double t;          ///< seconds from the set's epoch
  double r[3], v[3]; ///< the record's frame (velocity the derivative of r)
};

/// The 4-node Hermite (positions and velocities, degree 7) of states k0 .. k0 + 3 at time x: position and velocity.
inline void hermite4(const Point* s, double x, double out_r[3], double out_v[3]) {
  double z[8];
  for (int j = 0; j < 4; ++j) z[2 * j] = z[2 * j + 1] = s[j].t - s[0].t;
  const double xx = x - s[0].t;
  for (int a = 0; a < 3; ++a) {
    double q[8], coef[8];
    for (int j = 0; j < 4; ++j) q[2 * j] = q[2 * j + 1] = s[j].r[a];
    coef[0] = q[0];
    for (int lvl = 1; lvl < 8; ++lvl) {
      for (int i = 0; i < 8 - lvl; ++i)
        q[i] = (lvl == 1 && i % 2 == 0) ? s[i / 2].v[a] : (q[i + 1] - q[i]) / (z[i + lvl] - z[i]);
      coef[lvl] = q[0];
    }
    double p = coef[7], dp = 0.0;
    for (int j = 6; j >= 0; --j) {
      dp = dp * (xx - z[j]) + p;
      p = p * (xx - z[j]) + coef[j];
    }
    out_r[a] = p;
    out_v[a] = dp;
  }
}

/// The 8-node Lagrange interpolant (positions only, degree 7) of states s[0 .. 7] at time x: position and its derivative.
inline void lagrange8(const Point* s, double x, double out_r[3], double out_v[3]) {
  double l[8], d[8];
  for (int j = 0; j < 8; ++j) {
    double p = 1.0, dp = 0.0;
    for (int k = 0; k < 8; ++k) {
      if (k == j) continue;
      const double den = s[j].t - s[k].t;
      // d/dx of the product so far times (x - t_k) / den
      dp = dp * (x - s[k].t) / den + p / den;
      p *= (x - s[k].t) / den;
    }
    l[j] = p;
    d[j] = dp;
  }
  for (int a = 0; a < 3; ++a) {
    double p = 0.0, v = 0.0;
    for (int j = 0; j < 8; ++j) {
      p += l[j] * s[j].r[a];
      v += d[j] * s[j].r[a];
    }
    out_r[a] = p;
    out_v[a] = v;
  }
}

/// Least squares by Householder QR: A (m x n, row-major, overwritten), B (m x 3, overwritten) -> X (n x 3). False when
/// the columns are dependent.
inline bool lsq(std::vector<double>& A, size_t m, int n, std::vector<double>& B, double* X) {
  std::vector<double> v(m);
  for (int j = 0; j < n; ++j) {
    double s = 0.0;
    for (size_t i = j; i < m; ++i) s += A[i * n + j] * A[i * n + j];
    const double norm = std::sqrt(s);
    if (!(norm > 0.0)) return false;
    const double alpha = A[j * n + j] > 0.0 ? -norm : norm;
    double vv = 0.0;
    for (size_t i = j; i < m; ++i) {
      v[i] = (i == static_cast<size_t>(j)) ? A[i * n + j] - alpha : A[i * n + j];
      vv += v[i] * v[i];
    }
    if (!(vv > 0.0)) continue;
    for (int c = j; c < n; ++c) {
      double d = 0.0;
      for (size_t i = j; i < m; ++i) d += v[i] * A[i * n + c];
      d = 2.0 * d / vv;
      for (size_t i = j; i < m; ++i) A[i * n + c] -= d * v[i];
    }
    for (int c = 0; c < 3; ++c) {
      double d = 0.0;
      for (size_t i = j; i < m; ++i) d += v[i] * B[i * 3 + c];
      d = 2.0 * d / vv;
      for (size_t i = j; i < m; ++i) B[i * 3 + c] -= d * v[i];
    }
  }
  for (int c = 0; c < 3; ++c)
    for (int j = n - 1; j >= 0; --j) {
      double s = B[j * 3 + c];
      for (int q = j + 1; q < n; ++q) s -= A[j * n + q] * X[q * 3 + c];
      if (!(std::fabs(A[j * n + j]) > 0.0)) return false;
      X[j * 3 + c] = s / A[j * n + j];
    }
  return true;
}

/// Where a segment starts when one comes before it: that segment's own position, velocity and acceleration at its end.
struct Edge {
  bool on = false;
  double r[3] = {}, v[3] = {}, a[3] = {};
};

/// Position, velocity and acceleration of the series c (n per axis, x then y then z) of a segment (mid, half) at t.
inline void series2(const double* c, int n, double mid, double half, double t, double p[3], double pd[3], double pdd[3]) {
  const double tau = (t - mid) / half;
  double T[kMaxCoefficients], D[kMaxCoefficients], D2[kMaxCoefficients];
  T[0] = 1.0;
  D[0] = D2[0] = 0.0;
  if (n > 1) {
    T[1] = tau;
    D[1] = 1.0;
    D2[1] = 0.0;
  }
  for (int k = 2; k < n; ++k) {
    T[k] = 2.0 * tau * T[k - 1] - T[k - 2];
    D[k] = 2.0 * T[k - 1] + 2.0 * tau * D[k - 1] - D[k - 2];
    D2[k] = 4.0 * D[k - 1] + 2.0 * tau * D2[k - 1] - D2[k - 2];
  }
  for (int a = 0; a < 3; ++a) {
    double sp = 0.0, sd = 0.0, sdd = 0.0;
    for (int k = 0; k < n; ++k) {
      sp += c[a * n + k] * T[k];
      sd += c[a * n + k] * D[k];
      sdd += c[a * n + k] * D2[k];
    }
    p[a] = sp;
    pd[a] = sd / half;
    pdd[a] = sdd / (half * half);
  }
}

/// One fitted segment: its window (indices into the densified points), mid as written, coefficients and residuals.
struct Fitted {
  size_t i0 = 0, i1 = 0;
  int n = 0;
  double mid = 0.0, half = 0.0;
  char mid_text[48] = {};
  std::vector<double> c;  ///< x then y then z, n each
  double max_km = 0.0, rms_km = 0.0, max_v = 0.0;  ///< position (km) and velocity (km/s) residuals, checked points
};

/// The segment of points i0 .. i1 under n coefficients, its EPOCH_MID the window's middle at the text's microsecond:
/// least squares on the forecast's interpolant `at` (time -> Point) at the window's 2n Chebyshev points (positions and
/// velocities: the series is pinned where its high terms move, near the ends) and on the window's two end points
/// (weight kJoinWeight): its start the segment before's end (`edge`: position, velocity and acceleration, so
/// consecutive segments meet to the second derivative and the output's second difference has no step at a joint), or
/// the first point; true when every point of the window, the interpolant halfway between two (E[i] between D[i] and
/// D[i + 1]) and at the Chebyshev points and halfway between them, is within kToleranceKm and `vtol` (km/s).
template <class At>
inline bool fit_segment(const std::vector<Point>& D, const std::vector<Point>& E, const At& at, const Edge& edge, size_t i0, size_t i1, int n, double vtol,
                        double w, double f, Fitted& out) {
  out.i0 = i0;
  out.i1 = i1;
  out.n = n;
  const double a = D[i0].t, b = D[i1].t;
  oem::iso_text(w, f, 0.5 * (a + b) / 60.0, out.mid_text, sizeof out.mid_text);
  double mw, mf;
  if (!omm::epoch(out.mid_text, static_cast<uint32_t>(std::strlen(out.mid_text)), mw, mf)) return false;
  out.mid = ((mw - w) + (mf - f)) * 86400.0;
  out.half = std::fmax(out.mid - a, b - out.mid) + 1.0e-9;  // a nanosecond over: mid -/+ half holds both ends after rounding
  if (!(out.half > 0.0)) return false;
  // the Chebyshev points of the window (and halfway between consecutive ones), on the interpolant
  const int M = 2 * n;
  std::vector<Point> C(static_cast<size_t>(2 * M - 1));
  for (int j = 0; j < 2 * M - 1; ++j) {
    const double theta = kPi * (0.5 * j + 0.5) / M;  // even j: the points; odd j: halfway (in angle) between two
    C[static_cast<size_t>(j)] = at(0.5 * (a + b) + 0.5 * (b - a) * std::cos(theta));
  }
  const size_t m = 2 * (static_cast<size_t>(M) + 2) + (edge.on ? 1 : 0);
  std::vector<double> A(m * n), B(m * 3);
  const double vw = kToleranceKm / vtol;  // velocity rows in position units: each residual over its bound
  double T[kMaxCoefficients], Dd[kMaxCoefficients], D2[kMaxCoefficients];
  auto basis = [&](double tau) {
    T[0] = 1.0;
    Dd[0] = D2[0] = 0.0;
    if (n > 1) {
      T[1] = tau;
      Dd[1] = 1.0;
      D2[1] = 0.0;
    }
    for (int k = 2; k < n; ++k) {
      T[k] = 2.0 * tau * T[k - 1] - T[k - 2];
      Dd[k] = 2.0 * T[k - 1] + 2.0 * tau * Dd[k - 1] - Dd[k - 2];
      D2[k] = 4.0 * Dd[k - 1] + 2.0 * tau * D2[k - 1] - D2[k - 2];
    }
  };
  size_t row = 0;
  auto add = [&](const Point& q, double jw) {
    basis((q.t - out.mid) / out.half);
    for (int k = 0; k < n; ++k) {
      A[row * n + k] = T[k] * jw;
      A[(row + 1) * n + k] = Dd[k] / out.half * vw * jw;
    }
    for (int c = 0; c < 3; ++c) {
      B[row * 3 + c] = q.r[c] * jw;
      B[(row + 1) * 3 + c] = q.v[c] * vw * jw;
    }
    row += 2;
  };
  if (edge.on) {
    Point q{};
    q.t = D[i0].t;
    std::memcpy(q.r, edge.r, sizeof q.r);
    std::memcpy(q.v, edge.v, sizeof q.v);
    add(q, kJoinWeight);
    // the acceleration row, in position units (times vw squared) and held like the end's position and velocity
    basis((q.t - out.mid) / out.half);
    for (int k = 0; k < n; ++k) A[row * n + k] = D2[k] / (out.half * out.half) * vw * vw * kJoinWeight;
    for (int c = 0; c < 3; ++c) B[row * 3 + c] = edge.a[c] * vw * vw * kJoinWeight;
    row += 1;
  } else {
    add(D[i0], kJoinWeight);
  }
  add(D[i1], kJoinWeight);
  for (int j = 0; j < M; ++j) add(C[static_cast<size_t>(2 * j)], 1.0);
  std::vector<double> X(static_cast<size_t>(n) * 3);
  if (!lsq(A, m, n, B, X.data())) return false;
  out.c.assign(static_cast<size_t>(n) * 3, 0.0);
  for (int k = 0; k < n; ++k)
    for (int c = 0; c < 3; ++c) out.c[c * n + k] = X[k * 3 + c];
  // the window's residuals
  Track one;
  one.c = out.c;
  Segment s{};
  s.mid = out.mid;
  s.half = out.half;
  s.inv_half = 1.0 / out.half;
  s.n = static_cast<uint32_t>(n);
  s.off = 0;
  double worst = 0.0, ss = 0.0, worst_v = 0.0;
  auto check = [&](const Point& q) {
    double p[3], pd[3];
    series(one, s, q.t, p, pd);
    const double e = std::sqrt((p[0] - q.r[0]) * (p[0] - q.r[0]) + (p[1] - q.r[1]) * (p[1] - q.r[1]) + (p[2] - q.r[2]) * (p[2] - q.r[2]));
    const double ev = std::sqrt((pd[0] - q.v[0]) * (pd[0] - q.v[0]) + (pd[1] - q.v[1]) * (pd[1] - q.v[1]) + (pd[2] - q.v[2]) * (pd[2] - q.v[2]));
    worst = std::fmax(worst, e);
    worst_v = std::fmax(worst_v, ev);
    ss += e * e;
  };
  for (size_t i = i0; i <= i1; ++i) {
    check(D[i]);
    if (i < i1) check(E[i]);
  }
  for (const Point& q : C) check(q);
  out.max_km = worst;
  out.max_v = worst_v;
  out.rms_km = std::sqrt(ss / static_cast<double>(2 * (i1 - i0) + 1 + C.size()));
  return std::isfinite(worst) && std::isfinite(worst_v) && worst <= kToleranceKm && worst_v <= vtol;
}

/// The segments of points a .. b under n coefficients: from each start the longest window within the tolerance (doubling
/// then bisection over the allowed ends: b, or an end leaving at least n points). False when a window of n points fails.
template <class At>
inline bool segments(const std::vector<Point>& D, const std::vector<Point>& E, const At& at, size_t a, size_t b, int n, double vtol, double w, double f,
                     std::vector<Fitted>& out) {
  out.clear();
  const size_t minpts = static_cast<size_t>(n);
  size_t i0 = a, guess = 4 * minpts;
  Fitted best, trial;
  Edge edge;
  auto pass = [&](size_t e, Fitted& into) { return fit_segment(D, E, at, edge, i0, e, n, vtol, w, f, into); };
  while (i0 < b) {
    // the ends allowed: emin .. emax (each leaving at least n points after it), and b
    const size_t emin = i0 + minpts - 1;
    size_t good;
    if (b < 2 * minpts + i0 - 1) {  // no inner end: the rest in one window
      if (!pass(b, best)) return false;
      good = b;
    } else {
      const size_t emax = b - minpts;
      if (!pass(emin, best)) return false;
      good = emin;
      size_t bad = SIZE_MAX;
      size_t probe = std::min(emax, std::max(i0 + guess, emin + 1));
      while (probe > good) {
        if (pass(probe, trial)) {
          std::swap(best, trial);
          good = probe;
          if (probe == emax) break;
          probe = std::min(emax, i0 + 2 * (probe - i0));
        } else {
          bad = probe;
          break;
        }
      }
      if (bad == SIZE_MAX) {  // every inner end tried passes: the rest in one window when it does too
        if (pass(b, trial)) {
          std::swap(best, trial);
          good = b;
        }
      } else {
        size_t lo = good, hi = bad;  // lo passes, hi fails
        while (hi - lo > 1) {
          const size_t mid = lo + (hi - lo) / 2;
          if (pass(mid, trial)) {
            std::swap(best, trial);
            good = lo = mid;
          } else {
            hi = mid;
          }
        }
      }
    }
    out.push_back(best);
    guess = good - i0;
    i0 = good;
    edge.on = true;
    series2(best.c.data(), best.n, best.mid, best.half, D[good].t, edge.r, edge.v, edge.a);
  }
  return true;
}

/// The bytes a PPE record of n coefficients adds to the record (measured layout: the table, its EPOCH_MID and three vectors).
inline size_t record_bytes(int n) { return 112u + 24u * static_cast<size_t>(n); }

/// What a record states about the forecast it carries (SPEC 18.6), built in the record's builder: its trajectory block
/// (TRAJECTORY_BLOCKS) and its span for METADATA START_TIME and STOP_TIME.
struct Described {
  flatbuffers::Offset<flatbuffers::Vector<flatbuffers::Offset<OCMTrajectoryBlock>>> blocks = 0;
  std::string start, stop;
};

/// The carried forecast of a fit: the block's states `all` (TEME of date, km, km/s; S has whole, frac, r, v, has_v; the
/// block given in GCRF or EME2000 when `from_gcrf`, the fit turning each state by the exact matrix), from
/// (sw, sf) to (ew, ef), as PPE records in `records` (built in fbb) in the frame of the set `row` (TEMEOFEPOCH when
/// `of_epoch`), the fit's COMMENT lines on it (the span, the segments and the jump from the forecast to the theory at
/// each end, theory minus forecast) and the record's statement of it in `described`, from the ephemeris block `blk`
/// (its COMMENT and ORBIT_DETERMINATION) and its $PVN `source` (or nullptr). 0, or 3 refused by name.
template <class S>
inline int build(flatbuffers::FlatBufferBuilder& fbb, const ElementRow& row, bool of_epoch, const std::vector<S>& all, bool from_gcrf, double sw, double sf, double ew,
                 double ef, const ephemerisDataBlock* blk, const PVN* source, flatbuffers::Offset<flatbuffers::Vector<flatbuffers::Offset<PPEPositionRecord>>>& records,
                 std::vector<std::string>& comment, Described& described) {
  const double w = row.epoch_jd_whole, f = row.epoch_jd_frac;
  const double t0 = ((sw - w) + (sf - f)) * 86400.0, t1 = ((ew - w) + (ef - f)) * 86400.0;
  if (!(t1 > t0)) return pcf::refuse("OUTPUT.STOP_TIME", "fit carries the block's states from OUTPUT.START_TIME to a later STOP_TIME");
  const size_t n = all.size();
  auto ts = [&](size_t k) { return ((all[k].whole - w) + (all[k].frac - f)) * 86400.0; };
  for (size_t k = 1; k < n; ++k)
    if (!(ts(k) > ts(k - 1))) return ocm::refuse("carry-order", "The block's states ascend in time: a carried forecast is read in order.");
  if (n < 4 || ts(0) > t0 || ts(n - 1) < t1)
    return ocm::refuse("carry-not-covered", "The ephemeris block's states do not reach from OUTPUT.START_TIME to OUTPUT.STOP_TIME.");
  size_t k0 = 0, k1 = n - 1;
  while (k0 + 1 < n && ts(k0 + 1) <= t0) ++k0;
  while (k1 > 0 && ts(k1 - 1) >= t1) --k1;
  // up to 4 states beyond each end join (the interpolant's nodes); states with velocities use the 4-node Hermite, a block
  // with a state without one the 8-node Lagrange of the positions (an analytic theory's velocity is not the derivative
  // of its position: SGP4 and SGP4XP differ by 20 to 70 mm/s in low orbit, measured)
  const size_t lo = k0 >= 4 ? k0 - 4 : 0, hi = std::min(n - 1, k1 + 4);
  bool with_v = true;
  for (size_t k = lo; k <= hi; ++k) with_v = with_v && all[k].has_v;
  const size_t nodes = with_v ? 4 : 8;
  if (hi - lo + 1 < nodes) return ocm::refuse("carry-not-covered", "A carried forecast takes at least 4 states of the block with velocities, 8 without.");
  // the states in the record's frame
  double q0[9] = {};
  if (of_epoch && !epoch_axes(w, f, q0)) return ocm::refuse("frame-failed", "No GCRF axes at the set's epoch (outside ERFA's calendar).");
  std::vector<Point> P(hi - lo + 1);
  // each state in GCRF: a GCRF (or EME2000) block's own state, undoing the fit's exact matrix (ERFA, gcrf.inc), any
  // other block's by the cubic; then in the record's axes: Q0 (TEMEOFEPOCH), or the cubic M (TEMEOFDATE, velocity its
  // derivative M v + dM/dt r). The series sees the input's own axes and the smooth cubic only: the exact matrix's
  // rounding (about 1e-11 rad from one call to the next) never enters it
  for (size_t k = lo; k <= hi; ++k) {
    const S& s = all[k];
    Point& p = P[k - lo];
    p.t = ts(k);
    double m[3][3], X[9], g[3], gv[3];
    if (from_gcrf) {
      if (frames::gcrf_to_teme(s.whole, s.frac, m) < 0) return ocm::refuse("frame-failed", "A state's UTC is outside ERFA's calendar.");
      std::memcpy(X, m, sizeof X);
    } else if (!frame_at(w, f + p.t / 86400.0, X, nullptr)) {
      return ocm::refuse("frame-failed", "A state's UTC is outside ERFA's calendar.");
    }
    mul_t(X, s.r, g);
    mul_t(X, s.v, gv);
    if (of_epoch) {
      mul(q0, g, p.r);
      mul(q0, gv, p.v);
    } else {
      double M[9], md[9], w1[3];
      if (!frame_at(w, f + p.t / 86400.0, M, md)) return ocm::refuse("frame-failed", "A state's UTC is outside ERFA's calendar.");
      mul(M, g, p.r);
      mul(M, gv, p.v);
      mul(md, g, w1);
      for (int a = 0; a < 3; ++a) p.v[a] += w1[a];
    }
  }
  // velocities that are not the positions' derivative (an analytic theory's: SGP4 and SGP4XP by 20 to 70 mm/s in low
  // orbit, measured) are not interpolated: the 8-node Lagrange of the positions takes over when the states' velocities
  // differ from that interpolant's derivative by more than kVelocityAgreementKmS RMS
  if (with_v && P.size() >= 8) {
    double ss = 0.0;
    size_t count = 0;
    for (size_t i = 3; i + 4 < P.size(); ++i) {  // the states the interpolant centers on
      double rr[3], vv[3];
      lagrange8(P.data() + (i - 3), P[i].t, rr, vv);
      const double d = std::sqrt((vv[0] - P[i].v[0]) * (vv[0] - P[i].v[0]) + (vv[1] - P[i].v[1]) * (vv[1] - P[i].v[1]) + (vv[2] - P[i].v[2]) * (vv[2] - P[i].v[2]));
      ss += d * d;
      ++count;
    }
    if (count > 0 && !(std::sqrt(ss / static_cast<double>(count)) <= kVelocityAgreementKmS)) with_v = false;
  }
  const size_t nodes_used = with_v ? 4 : 8;
  if (P.size() < nodes_used) return ocm::refuse("carry-not-covered", "A carried forecast takes at least 8 states of the block when their velocities are not their positions' derivative.");
  // densified: kDensify points per interval by the interpolant, the span's two ends among them
  // states close enough for their interpolant to hold the forecast: at most kMaxArcRad of arc apart about the Earth
  for (size_t i = k0 - lo; i < k1 - lo; ++i) {
    const double* x = P[i].r;
    const double* y = P[i + 1].r;
    const double cx = x[1] * y[2] - x[2] * y[1], cy = x[2] * y[0] - x[0] * y[2], cz = x[0] * y[1] - x[1] * y[0];
    const double arc = std::atan2(std::sqrt(cx * cx + cy * cy + cz * cz), x[0] * y[0] + x[1] * y[1] + x[2] * y[2]);
    if (arc > kMaxArcRad) {
      char why[200], when[48];
      oem::iso_text(w, f, P[i].t / 60.0, when, sizeof when);
      std::snprintf(why, sizeof why, "The block's states at %s are %.3f rad of arc apart, more than the %.2f a carried forecast is built from (30 s in low orbit).", when, arc, kMaxArcRad);
      return ocm::refuse("carry-states-sparse", why);
    }
  }
  // the interpolant of the interval of P starting at state i: the Hermite on nodes i - 1 .. i + 2, the Lagrange on
  // i - 3 .. i + 4, held inside P
  auto interpolated = [&](size_t i, double t) {
    Point q{};
    q.t = t;
    const size_t back = with_v ? 1 : 3;
    const size_t j = std::min(i >= back ? i - back : 0, P.size() - nodes_used);
    if (with_v) hermite4(P.data() + j, t, q.r, q.v);
    else lagrange8(P.data() + j, t, q.r, q.v);
    return q;
  };
  std::vector<Point> D;
  D.reserve(P.size() * kDensify + 2);
  for (size_t i = 0; i + 1 < P.size(); ++i) {
    D.push_back(with_v ? P[i] : interpolated(i, P[i].t));  // without velocities a state's own is the interpolant's derivative
    for (int j = 1; j < kDensify; ++j) D.push_back(interpolated(i, P[i].t + (P[i + 1].t - P[i].t) * j / kDensify));
  }
  D.push_back(with_v ? P.back() : interpolated(P.size() - 2, P.back().t));
  // the span's two ends among the points
  auto end_at = [&](double t) {
    size_t k = 0;
    while (k < D.size() && D[k].t < t) ++k;
    if (k < D.size() && D[k].t == t) return k;
    size_t i = 0;
    while (i + 2 < P.size() && P[i + 1].t <= t) ++i;
    D.insert(D.begin() + static_cast<std::ptrdiff_t>(k), interpolated(i, t));
    return k;
  };
  const size_t a = end_at(t0), b = end_at(t1);
  if (!(b > a)) return ocm::refuse("carry-not-covered", "The ephemeris block's states do not reach from OUTPUT.START_TIME to OUTPUT.STOP_TIME.");
  // the interpolant at any time (its interval of P found by bisection)
  auto at_time = [&](double t) {
    size_t lo2 = 0, hi2 = P.size() - 1;
    while (hi2 - lo2 > 1) {
      const size_t m2 = (lo2 + hi2) >> 1;
      if (P[m2].t <= t) lo2 = m2;
      else hi2 = m2;
    }
    return interpolated(std::min(lo2, P.size() - 2), t);
  };
  // the interpolant halfway between consecutive points, where the segments are checked too
  std::vector<Point> E(D.size() - 1);
  for (size_t i = 0, ip = 0; i + 1 < D.size(); ++i) {
    const double tm = 0.5 * (D[i].t + D[i + 1].t);
    while (ip + 2 < P.size() && P[ip + 1].t <= tm) ++ip;
    E[i] = interpolated(ip, tm);
  }
  // the fewest coefficients within kBytesSlack of the fewest bytes (a state costs in proportion to its coefficients)
  std::vector<std::vector<Fitted>> tried;
  std::vector<size_t> tried_bytes;
  std::vector<int> tried_n;
  size_t fewest = SIZE_MAX;
  for (const int nc : kCandidates) {
    if (b - a + 1 < static_cast<size_t>(nc)) continue;
    std::vector<Fitted> trial;
    if (!segments(D, E, at_time, a, b, nc, with_v ? kVelocityToleranceKmS : kPositionsOnlyVelocityKmS, w, f, trial)) continue;
    size_t bytes = 0;
    for (const Fitted& s : trial) bytes += record_bytes(s.n);
    fewest = std::min(fewest, bytes);
    tried.push_back(std::move(trial));
    tried_bytes.push_back(bytes);
    tried_n.push_back(nc);
  }
  std::vector<Fitted> best;
  size_t best_bytes = 0;
  int best_n = 0;
  for (size_t q = 0; q < tried.size(); ++q)
    if (static_cast<double>(tried_bytes[q]) <= (1.0 + kBytesSlack) * static_cast<double>(fewest)) {
      best.swap(tried[q]);
      best_bytes = tried_bytes[q];
      best_n = tried_n[q];
      break;
    }
  if (best.empty())
    return ocm::refuse("carry-tolerance", with_v ? "No Chebyshev segments of 16 to 64 coefficients hold the forecast within 1 cm and 0.05 mm/s of its states' interpolant: the states are too sparse or the forecast is not smooth (a maneuver)."
                                                 : "No Chebyshev segments of 16 to 64 coefficients hold the forecast within 1 cm and 1 mm/s of its positions' interpolant: the states are too sparse or the forecast is not smooth (a maneuver).");
  std::vector<flatbuffers::Offset<PPEPositionRecord>> out;
  out.reserve(best.size());
  double worst = 0.0, worst_v = 0.0;
  for (const Fitted& s : best) {
    worst_v = std::fmax(worst_v, s.max_v);
    const auto mid = fbb.CreateString(s.mid_text);
    const auto cx = fbb.CreateVector(s.c.data(), static_cast<size_t>(s.n));
    const auto cy = fbb.CreateVector(s.c.data() + s.n, static_cast<size_t>(s.n));
    const auto cz = fbb.CreateVector(s.c.data() + 2 * s.n, static_cast<size_t>(s.n));
    PPEPositionRecordBuilder pb(fbb);
    pb.add_EPOCH_MID(mid);
    pb.add_EPOCH_HALF_SPAN(s.half);
    pb.add_NUM_COEFFICIENTS(static_cast<uint16_t>(s.n));
    pb.add_POS_COEFF_X(cx);
    pb.add_POS_COEFF_Y(cy);
    pb.add_POS_COEFF_Z(cz);
    pb.add_MAX_POSITION_RESIDUAL(s.max_km);
    pb.add_RMS_POSITION_RESIDUAL(s.rms_km);
    out.push_back(pb.Finish());
    worst = std::fmax(worst, s.max_km);
  }
  records = fbb.CreateVector(out);
  // the track as flight reads it, and the jump at each end: the theory less the forecast, in the forecast's UVW axes
  Track tr;
  tr.frame = of_epoch ? 2 : 1;
  tr.w = w;
  tr.f = f;
  std::memcpy(tr.q0, q0, sizeof q0);
  for (const Fitted& s : best) {
    Segment g{};
    g.mid = s.mid;
    g.half = s.half;
    g.inv_half = 1.0 / s.half;
    g.start = s.mid - s.half;
    g.n = static_cast<uint32_t>(s.n);
    g.off = static_cast<uint32_t>(tr.c.size());
    g.state = kRead;
    tr.c.insert(tr.c.end(), s.c.begin(), s.c.end());
    tr.segs.push_back(g);
  }
  tr.start = tr.segs.front().start;
  tr.stop = tr.segs.back().mid + tr.segs.back().half;
  char start_text[48], stop_text[48], line[400];
  oem::iso_text(w, f, tr.start / 60.0, start_text, sizeof start_text);
  oem::iso_text(w, f, tr.stop / 60.0, stop_text, sizeof stop_text);
  std::snprintf(line, sizeof line,
                "carried forecast: %zu Chebyshev segments of %d coefficients (POLYNOMIAL_POSITION_RECORDS, %s), %s to %s, %zu bytes, at most %.2f mm and %.4f mm/s from the %s of the block's states",
                best.size(), best_n, of_epoch ? "TEMEOFEPOCH" : "TEMEOFDATE", start_text, stop_text, best_bytes, worst * 1.0e6, worst_v * 1.0e6,
                with_v ? "4-node Hermite" : "8-node Lagrange of the positions");
  comment.push_back(line);
  xpt::XpSat* xs = static_cast<xpt::XpSat*>(std::malloc(sizeof(xpt::XpSat)));
  const bool theory = xs != nullptr && xpt::xp_init(elements_of(row), *xs) == kPropOk;
  int rc = 0;
  for (int end = 0; end < 2 && rc == 0; ++end) {
    const double t = end == 0 ? tr.start : tr.stop;
    double rc_[3], vc[3], rm[3], vm[3], d[3], u[3];
    if (at(tr, t, rc_, vc) != 0) {
      rc = ocm::refuse("frame-failed", "No GCRF axes over the carried span (outside ERFA's calendar).");
      break;
    }
    if (!theory || xpt::xp_propagate(*xs, t / 60.0, rm, vm) != kPropOk) {
      std::snprintf(line, sizeof line, "carried forecast %s %s: the theory does not reach it", end == 0 ? "start" : "stop", end == 0 ? start_text : stop_text);
    } else {
      double dv[3];
      for (int k = 0; k < 3; ++k) {
        d[k] = rm[k] - rc_[k];
        dv[k] = vm[k] - vc[k];
      }
      cov::to_uvw(rc_, vc, d, u);
      std::snprintf(line, sizeof line,
                    "carried forecast %s %s: theory minus forecast %.6f km (radial %.6f, in-track %.6f, cross-track %.6f km), velocity %.6f mm/s",
                    end == 0 ? "start" : "stop", end == 0 ? start_text : stop_text, std::sqrt(d[0] * d[0] + d[1] * d[1] + d[2] * d[2]), u[0], u[1], u[2],
                    1.0e6 * std::sqrt(dv[0] * dv[0] + dv[1] * dv[1] + dv[2] * dv[2]));
    }
    comment.push_back(line);
  }
  if (xs != nullptr) {
    if (theory) xpt::xp_release(*xs);
    std::free(xs);
  }
  if (rc != 0) return rc;
  // SPEC 18.6: what the record states about its forecast, in its own trajectory block
  described.start = start_text;
  described.stop = stop_text;
  std::string about = "Carried forecast (SPEC 18): flown inside USEABLE_START_TIME to USEABLE_STOP_TIME; outside them the theory. Force model and weather: ";
  about += blk != nullptr && blk->COMMENT() != nullptr && blk->COMMENT()->size() > 0 ? blk->COMMENT()->str() : std::string("not stated by the ephemeris block");
  about += ". Initial state: ";
  const OEMOrbitDetermination* od = blk != nullptr ? blk->ORBIT_DETERMINATION() : nullptr;
  if (od != nullptr && (od->OD_METHOD() != nullptr || od->OD_ARC_START() != nullptr)) {
    std::snprintf(line, sizeof line, "%s, arc %s to %s, %u observations (the ephemeris block's ORBIT_DETERMINATION)", od->OD_METHOD() != nullptr ? od->OD_METHOD()->c_str() : "method not stated",
                  od->OD_ARC_START() != nullptr ? od->OD_ARC_START()->c_str() : "?", od->OD_ARC_STOP() != nullptr ? od->OD_ARC_STOP()->c_str() : "?", od->OD_OBSERVATIONS_USED());
    about += line;
  } else {
    about += "not stated by the ephemeris block";
  }
  about += ". Covariance inside the span: the theory's (COVARIANCE_DATA, SPEC 12), no realism claim for the forecast.";
  const auto s_about = fbb.CreateString(about);
  const auto s_id = fbb.CreateString("CARRIED FORECAST");
  const auto s_basis = fbb.CreateString("PREDICTED");
  const auto s_basis_id = source != nullptr && source->SOURCE_ID() != nullptr ? fbb.CreateString(source->SOURCE_ID()->str()) : flatbuffers::Offset<flatbuffers::String>(0);
  const auto s_propagator = source != nullptr && source->PRODUCER() != nullptr ? fbb.CreateString(source->PRODUCER()->str()) : flatbuffers::Offset<flatbuffers::String>(0);
  const auto s_interp = fbb.CreateString("CHEBYSHEV");
  const auto s_center = fbb.CreateString("EARTH");
  const auto s_frame = fbb.CreateString(of_epoch ? "TEMEOFEPOCH" : "TEMEOFDATE");
  char epoch_text[48];
  oem::iso_text(w, f, 0.0, epoch_text, sizeof epoch_text);
  const auto s_frame_epoch = of_epoch ? fbb.CreateString(epoch_text) : flatbuffers::Offset<flatbuffers::String>(0);
  const auto s_start = fbb.CreateString(start_text);
  const auto s_stop = fbb.CreateString(stop_text);
  const auto s_type = fbb.CreateString("POLYNOMIAL_POS");
  const auto s_units = fbb.CreateString("km");
  OCMTrajectoryBlockBuilder tb(fbb);
  tb.add_COMMENT(s_about);
  tb.add_TRAJ_ID(s_id);
  tb.add_TRAJ_BASIS(s_basis);
  if (!s_basis_id.IsNull()) tb.add_TRAJ_BASIS_ID(s_basis_id);
  tb.add_INTERPOLATION(s_interp);
  tb.add_INTERPOLATION_DEGREE(static_cast<uint32_t>(best_n - 1));
  if (!s_propagator.IsNull()) tb.add_PROPAGATOR(s_propagator);
  tb.add_CENTER_NAME(s_center);
  tb.add_TRAJ_REF_FRAME(s_frame);
  if (!s_frame_epoch.IsNull()) tb.add_TRAJ_FRAME_EPOCH(s_frame_epoch);
  tb.add_USEABLE_START_TIME(s_start);
  tb.add_USEABLE_STOP_TIME(s_stop);
  tb.add_TRAJ_TYPE(s_type);
  tb.add_TRAJ_UNITS(s_units);
  const auto block = tb.Finish();
  described.blocks = fbb.CreateVector(&block, 1);
  return 0;
}

}  // namespace carried
}  // namespace sdnap

/// The angle (rad, the largest element of the difference) between the carried forecast's GCRF -> TEME of date matrix
/// (the module's output matrix, made orthonormal) and the exact chain at the split Julian date whole + frac (UTC): ERFA's
/// IAU 2006/2000A with GMST82 unrounded (gcrf.inc gmst82_unrounded): SPEC 18's frame bound. NaN outside ERFA's calendar.
SDNAP_EXPORT("sdnap_carried_frame_error")
double sdnap_carried_frame_error(double whole, double frac) {
  double M[9], m[3][3], tai1, tai2, tt1, tt2;
  if (!sdnap::carried::frame_at(whole, frac, M, nullptr) || eraUtctai(whole, frac, &tai1, &tai2) < 0) return std::numeric_limits<double>::quiet_NaN();
  eraTaitt(tai1, tai2, &tt1, &tt2);
  eraPnm06a(tt1, tt2, m);
  eraRz(eraGst06(whole, frac, tt1, tt2, m) - sdnap::frames::gmst82_unrounded(whole, frac), m);
  double worst = 0.0;
  for (int i = 0; i < 3; ++i)
    for (int j = 0; j < 3; ++j) worst = std::fmax(worst, std::fabs(M[3 * i + j] - m[i][j]));
  return worst;
}
