// -----------------------------------------------------------------------------
// Display segments (a timing prototype). Each row of the element store gets a
// few polynomial segments of its own theory's positions, so a catalog step at
// one instant evaluates one short polynomial per object instead of the theory.
// For drawing and screening many objects fast: the segments follow the theory to
// a stated tolerance and change nothing about the theory or its accuracy.
//
// A row's segments share one length, its orbital period (from the theory's state
// at the store's epoch, by the vis-viva relation) over a division k, the
// smallest of kDivisions whose segments all hold the tolerance at their checks:
// the theory's position at tau = -1, -1/2, 0, 1/2 and 1, and the velocity (the
// series' derivative) at tau = 1/2 against the five-point central difference
// of the theory's positions 1 and 2 s each side. A segment interpolates the theory's
// positions at its n Chebyshev nodes and is kept as monomial coefficients in
// tau, x and y interleaved (one SIMD pair a term), then z: 24 n bytes. A state
// is r = p(tau), v = p'(tau) 2 / length: the derivative of the position series,
// not the theory's own velocity (an analytic theory's velocity is not its
// position's derivative). The batch entries run on the pool (pool.inc), each
// row on one thread.
// -----------------------------------------------------------------------------

namespace sdnap {
namespace segments {

constexpr uint32_t kMaxCoefficients = 16;
constexpr int32_t kDivisions[] = {4, 6, 8, 12, 16, 24, 32, 48, 64, 96, 128, 192, 256};
constexpr int32_t kNotCovered = 1;     ///< the time is outside the row's segments
constexpr int32_t kNoSegments = 2;     ///< the row has no segments (no division held the tolerance): fly its theory
constexpr int32_t kNoDivision = -10;   ///< no division of the period holds the tolerance
constexpr double kMu = 398600.4418;    ///< km^3/s^2, for the period only

struct Store {
  uint32_t rows = 0, per_row = 0, n = 0;
  double w0 = 0.0, f0 = 0.0;           ///< the store's epoch, split Julian date (UTC): times are seconds from it
  double tol_km = 0.0, tol_kms = 0.0;
  double* t0 = nullptr;                ///< per row: its first segment's start (s from the epoch)
  double* inv_len = nullptr;           ///< per row: 1 / segment length (1/s)
  double* minutes0 = nullptr;          ///< per row: minutes from the row's own epoch at the store's epoch
  uint32_t* built = nullptr;           ///< per row: segments built
  int32_t* division = nullptr;         ///< per row: k (0 when none held)
  float* worst = nullptr;              ///< per row: the largest position (m) and velocity (mm/s) misses at the checks
  double* c = nullptr;                 ///< per row, per segment: 3 n coefficients
};

inline Store& seg_store() {
  static Store s;
  return s;
}

inline void seg_free() {
  Store& s = seg_store();
  std::free(s.t0); std::free(s.inv_len); std::free(s.minutes0); std::free(s.built); std::free(s.division);
  std::free(s.worst); std::free(s.c);
  s = Store{};
}

inline size_t seg_bytes() {
  const Store& s = seg_store();
  return static_cast<size_t>(s.rows) * (3 * sizeof(double) + 2 * sizeof(uint32_t) + 2 * sizeof(float)) +
         static_cast<size_t>(s.rows) * s.per_row * 3u * s.n * sizeof(double);
}

/// The theory's position (km) of row i at `s` seconds from the store's epoch; 0 or the theory's code.
inline int32_t theory_at(uint32_t i, double minutes0, double s, double r[3]) {
  double v[3];
  return row_propagate(i, minutes0 + s / 60.0, r, v);
}

/// Monomial coefficients in tau of the Chebyshev interpolant of the positions at the n nodes (Chebyshev-Gauss) of
/// [a, a + len] seconds; out: n (x, y) pairs then n z. 0 or the theory's code.
inline int32_t fit_segment(uint32_t i, double minutes0, double a, double len, uint32_t n, double* out) {
  double P[kMaxCoefficients][3], cheb[3][kMaxCoefficients];
  const double mid = a + 0.5 * len, half = 0.5 * len;
  for (uint32_t k = 0; k < n; ++k) {
    const double x = std::cos(kPi * (k + 0.5) / n);
    if (const int32_t e = theory_at(i, minutes0, mid + half * x, P[k])) return e;
  }
  for (int ax = 0; ax < 3; ++ax)
    for (uint32_t m = 0; m < n; ++m) {
      double sum = 0.0;
      for (uint32_t k = 0; k < n; ++k) sum += P[k][ax] * std::cos(kPi * m * (k + 0.5) / n);
      cheb[ax][m] = (m == 0 ? 1.0 : 2.0) * sum / n;
    }
  // T_m in monomials: T_0 = 1, T_1 = x, T_{m+1} = 2 x T_m - T_{m-1}
  double T[kMaxCoefficients][kMaxCoefficients] = {};
  T[0][0] = 1.0;
  if (n > 1) T[1][1] = 1.0;
  for (uint32_t m = 1; m + 1 < n; ++m)
    for (uint32_t j = 0; j < n; ++j) T[m + 1][j] = (j > 0 ? 2.0 * T[m][j - 1] : 0.0) - T[m - 1][j];
  for (uint32_t j = 0; j < n; ++j) {
    double p[3] = {0, 0, 0};
    for (uint32_t m = j; m < n; ++m)
      for (int ax = 0; ax < 3; ++ax) p[ax] += cheb[ax][m] * T[m][j];
    out[2 * j] = p[0];
    out[2 * j + 1] = p[1];
    out[2 * n + j] = p[2];
  }
  return 0;
}

/// Position p and its derivative dp (per unit tau) of a segment's coefficients at tau.
inline void eval(const double* c, uint32_t n, double tau, double p[3], double dp[3]) {
#ifdef __wasm_simd128__
  const v128_t tt = wasm_f64x2_splat(tau);
  v128_t pxy = wasm_v128_load(c + 2 * (n - 1)), dxy = wasm_f64x2_splat(0.0);
  for (uint32_t m = n - 1; m-- > 0;) {
    dxy = wasm_f64x2_add(wasm_f64x2_mul(dxy, tt), pxy);
    pxy = wasm_f64x2_add(wasm_f64x2_mul(pxy, tt), wasm_v128_load(c + 2 * m));
  }
  p[0] = wasm_f64x2_extract_lane(pxy, 0);
  p[1] = wasm_f64x2_extract_lane(pxy, 1);
  dp[0] = wasm_f64x2_extract_lane(dxy, 0);
  dp[1] = wasm_f64x2_extract_lane(dxy, 1);
#else
  double px = c[2 * (n - 1)], py = c[2 * (n - 1) + 1], dx = 0.0, dy = 0.0;
  for (uint32_t m = n - 1; m-- > 0;) {
    dx = dx * tau + px;
    dy = dy * tau + py;
    px = px * tau + c[2 * m];
    py = py * tau + c[2 * m + 1];
  }
  p[0] = px; p[1] = py; dp[0] = dx; dp[1] = dy;
#endif
  const double* z = c + 2 * n;
  double pz = z[n - 1], dz = 0.0;
  for (uint32_t m = n - 1; m-- > 0;) {
    dz = dz * tau + pz;
    pz = pz * tau + z[m];
  }
  p[2] = pz;
  dp[2] = dz;
}

/// Segment row i's segments from s = 0 (the store's epoch), from element row `el`'s theory: the smallest division of
/// its period whose per_row segments all hold the tolerance. 0, kNoDivision, or the theory's code.
inline int32_t build_row(uint32_t el, uint32_t i) {
  Store& S = seg_store();
  const uint32_t n = S.n;
  double* block = S.c + static_cast<size_t>(i) * S.per_row * 3u * n;
  S.built[i] = 0;
  S.division[i] = 0;
  S.t0[i] = 0.0;
  S.minutes0[i] = minutes_since_epoch(el, S.w0, S.f0);
  double r[3], v[3];
  if (const int32_t e = row_propagate(el, S.minutes0[i], r, v)) return e;
  const double rr = std::sqrt(r[0] * r[0] + r[1] * r[1] + r[2] * r[2]), vv = v[0] * v[0] + v[1] * v[1] + v[2] * v[2];
  const double inv_a = 2.0 / rr - vv / kMu;
  if (!(inv_a > 0.0)) return kNoDivision;
  const double period = 2.0 * kPi * std::sqrt(1.0 / (inv_a * inv_a * inv_a) / kMu);
  for (const int32_t k : kDivisions) {
    const double len = period / k;
    float worst_m = 0.0f, worst_mms = 0.0f;
    bool ok = true;
    for (uint32_t j = 0; j < S.per_row && ok; ++j) {
      double* c = block + static_cast<size_t>(j) * 3u * n;
      const double a = j * len;
      if (const int32_t e = fit_segment(el, S.minutes0[i], a, len, n, c)) return e;
      for (const double tau : {-1.0, -0.5, 0.0, 0.5, 1.0}) {
        double p[3], dp[3], t[3];
        eval(c, n, tau, p, dp);
        if (const int32_t e = theory_at(el, S.minutes0[i], a + 0.5 * (tau + 1.0) * len, t)) return e;
        const double miss = std::sqrt((p[0] - t[0]) * (p[0] - t[0]) + (p[1] - t[1]) * (p[1] - t[1]) + (p[2] - t[2]) * (p[2] - t[2]));
        worst_m = std::fmax(worst_m, static_cast<float>(miss * 1.0e3));
        if (!(miss <= S.tol_km)) ok = false;
        if (tau == 0.5) {
          // the theory's position derivative: the five-point central difference over 1 and 2 s (truncation
          // about 1e-13 km/s in low orbit)
          double p1[3], m1[3], p2[3], m2[3];
          const double s = a + 0.75 * len;
          if (const int32_t e = theory_at(el, S.minutes0[i], s + 1.0, p1)) return e;
          if (const int32_t e = theory_at(el, S.minutes0[i], s - 1.0, m1)) return e;
          if (const int32_t e = theory_at(el, S.minutes0[i], s + 2.0, p2)) return e;
          if (const int32_t e = theory_at(el, S.minutes0[i], s - 2.0, m2)) return e;
          double dv = 0.0;
          for (int ax = 0; ax < 3; ++ax) {
            const double d = dp[ax] * 2.0 / len - (8.0 * (p1[ax] - m1[ax]) - (p2[ax] - m2[ax])) / 12.0;
            dv += d * d;
          }
          dv = std::sqrt(dv);
          worst_mms = std::fmax(worst_mms, static_cast<float>(dv * 1.0e6));
          if (!(dv <= S.tol_kms)) ok = false;
        }
      }
    }
    // the misses of the attempt (a row no division holds keeps its finest attempt's, to say why)
    S.worst[2 * i] = worst_m;
    S.worst[2 * i + 1] = worst_mms;
    if (ok) {
      S.inv_len[i] = 1.0 / len;
      S.built[i] = S.per_row;
      S.division[i] = k;
      return 0;
    }
  }
  return kNoDivision;
}

}  // namespace segments

namespace pool {
void segments_chunk(const Job& j, int32_t chunk) {
  segments::Store& S = segments::seg_store();
  const uint32_t begin = static_cast<uint32_t>(chunk) * kChunk;
  const uint32_t end = begin + kChunk < j.count ? begin + kChunk : j.count;
  if (j.kind == kJobSegmentsBuild) {
    // element rows [first, first + count) into segment rows from `frame` (the offset, reused for the build)
    for (uint32_t k = begin; k < end; ++k) {
      const int32_t e = segments::build_row(j.first + k, j.frame + k);
      if (j.status != nullptr) j.status[k] = e;
    }
    return;
  }
  const uint32_t n = j.count, nc = S.n;
  double *x = j.out, *y = x + n, *z = y + n, *vx = z + n, *vy = vx + n, *vz = vy + n;
  for (uint32_t k = begin; k < end; ++k) {
    const uint32_t i = j.first + k;
    const double u = (j.seconds - S.t0[i]) * S.inv_len[i];
    const double fj = std::floor(u);
    int32_t e = 0;
    double r[3] = {0, 0, 0}, v[3] = {0, 0, 0};
    if (S.built[i] == 0) {
      e = segments::kNoSegments;  // the caller flies this row's theory directly
    } else if (!(fj >= 0.0) || !(fj < static_cast<double>(S.built[i]))) {
      e = segments::kNotCovered;
    } else {
      const uint32_t seg = static_cast<uint32_t>(fj);
      const double* c = S.c + (static_cast<size_t>(i) * S.per_row + seg) * 3u * nc;
      double dp[3];
      segments::eval(c, nc, 2.0 * (u - fj) - 1.0, r, dp);
      const double scale = 2.0 * S.inv_len[i];
      v[0] = dp[0] * scale; v[1] = dp[1] * scale; v[2] = dp[2] * scale;
    }
    if (j.status != nullptr) j.status[k] = e;
    if (e == 0 && j.frame == ORBPRO_FRAME_ECEF) {
      double ro[3], vo[3];
      teme_to_ecef_m(j.theta, r, v, ro, vo);
      x[k] = ro[0]; y[k] = ro[1]; z[k] = ro[2]; vx[k] = vo[0]; vy[k] = vo[1]; vz[k] = vo[2];
    } else {
      x[k] = r[0]; y[k] = r[1]; z[k] = r[2]; vx[k] = v[0]; vy[k] = v[1]; vz[k] = v[2];
    }
  }
}
}  // namespace pool
}  // namespace sdnap

/// Builds display segments from the split Julian date (UTC) for every row of the element store, into segment rows
/// [offset, offset + count) of a segment store of `total` rows (made anew when offset is 0 or its shape differs; a
/// worker loads its sets in batches, builds them and replaces them, and the segments stay): `per_row` segments of
/// `coefficients` (2 to 16) monomial terms per axis, each holding the row's theory within `tol_m` meters and `tol_mm_s`
/// mm/s at its checks (segments.inc). `status` (optional): one code per element row, 0 built, -10 no division of the
/// period holds the tolerance, else the theory's. Returns 0, or a negative code.
SDNAP_EXPORT("sdnap_segments_build")
int32_t sdnap_segments_build(double jd_whole, double jd_frac, uint32_t total, uint32_t offset, uint32_t per_row, uint32_t coefficients, double tol_m, double tol_mm_s,
                             int32_t* status) {
  const sdnap::Store& st = sdnap::store();
  if (st.count == 0) return ORBPRO_PROP_NOT_INITIALIZED;
  if (per_row < 1 || coefficients < 2 || coefficients > sdnap::segments::kMaxCoefficients || !(tol_m > 0.0) || !(tol_mm_s > 0.0) || offset > total ||
      st.count > total - offset)
    return ORBPRO_PROP_BAD_INPUT;
  sdnap::segments::Store& S = sdnap::segments::seg_store();
  if (offset == 0 || S.rows != total || S.per_row != per_row || S.n != coefficients || S.w0 != jd_whole || S.f0 != jd_frac) {
    sdnap::segments::seg_free();
    const uint32_t n = total;
    S.rows = n; S.per_row = per_row; S.n = coefficients; S.w0 = jd_whole; S.f0 = jd_frac;
    S.t0 = static_cast<double*>(std::malloc(sizeof(double) * n));
    S.inv_len = static_cast<double*>(std::malloc(sizeof(double) * n));
    S.minutes0 = static_cast<double*>(std::malloc(sizeof(double) * n));
    S.built = static_cast<uint32_t*>(std::malloc(sizeof(uint32_t) * n));
    S.division = static_cast<int32_t*>(std::malloc(sizeof(int32_t) * n));
    S.worst = static_cast<float*>(std::calloc(2 * n, sizeof(float)));
    S.c = static_cast<double*>(std::malloc(sizeof(double) * static_cast<size_t>(n) * per_row * 3u * coefficients));
    if (!S.t0 || !S.inv_len || !S.minutes0 || !S.built || !S.division || !S.worst || !S.c) { sdnap::segments::seg_free(); return ORBPRO_PROP_BAD_INPUT; }
    for (uint32_t i = 0; i < n; ++i) { S.built[i] = 0; S.inv_len[i] = 0.0; S.t0[i] = 0.0; S.division[i] = 0; }
  }
  S.tol_km = tol_m * 1.0e-3; S.tol_kms = tol_mm_s * 1.0e-6;
  sdnap::pool::Job& j = sdnap::pool::job();
  j.kind = sdnap::pool::kJobSegmentsBuild;
  j.first = 0;
  j.count = st.count;
  j.frame = offset;
  j.status = status;
  sdnap::pool::run(st.count);
  return ORBPRO_PROP_OK;
}

/// The gravity terms the next sdnap_init_elements gives its SGP4XP rows (AP's, SPEC 16: 0 and 0 for the stock theory),
/// on the theory's own flux model. A prototype's selection: the product would take them from a $PCF.
SDNAP_EXPORT("sdnap_segments_select")
int32_t sdnap_segments_select(int32_t tesseral, int32_t zonal) {
  sdnap::xpt::tess::active() = sdnap::xpt::tess::Terms{tesseral, zonal};
  return 0;
}

/// Rows [first, first + count) at one split Julian date (UTC) from their display segments: six planes as
/// sdnap_propagate_soa, frame 0 (TEME: km, km/s) or 3 (Earth-fixed: m, m/s); `status` (optional) 0, 1 where the time
/// is outside the row's segments, 2 where the row has none (no division held the tolerance: the caller flies its
/// theory directly, so no object is dropped or shown beyond the tolerance).
SDNAP_EXPORT("sdnap_segments_at")
int32_t sdnap_segments_at(double jd_whole, double jd_frac, uint32_t first, uint32_t count, uint32_t frame, double* out, int32_t* status) {
  const sdnap::segments::Store& S = sdnap::segments::seg_store();
  if (S.rows == 0) return ORBPRO_PROP_NOT_INITIALIZED;
  if (out == nullptr) return ORBPRO_PROP_NULL_OUTPUT;
  if (first > S.rows || count > S.rows - first) return ORBPRO_PROP_BAD_ENTITY_INDEX;
  if (frame != ORBPRO_FRAME_TEME && frame != ORBPRO_FRAME_ECEF) return ORBPRO_PROP_BAD_INPUT;
  sdnap::pool::Job& j = sdnap::pool::job();
  j.kind = sdnap::pool::kJobSegmentsAt;
  j.first = first;
  j.count = count;
  j.frame = frame;
  j.out = out;
  j.status = status;
  j.seconds = ((jd_whole - S.w0) + (jd_frac - S.f0)) * 86400.0;
  j.theta = frame == ORBPRO_FRAME_ECEF ? sdnap::gmst(jd_whole, jd_frac) : 0.0;
  sdnap::pool::run(count);
  return ORBPRO_PROP_OK;
}

/// Row `row`'s segments: out[0] the division k of its period (0: none), out[1] the segment length (s), out[2] the
/// segments built, out[3] and out[4] the largest position (m) and velocity (mm/s) misses at its checks.
SDNAP_EXPORT("sdnap_segments_row")
int32_t sdnap_segments_row(uint32_t row, double* out) {
  const sdnap::segments::Store& S = sdnap::segments::seg_store();
  if (row >= S.rows || out == nullptr) return ORBPRO_PROP_BAD_ENTITY_INDEX;
  out[0] = S.division[row];
  out[1] = S.inv_len[row] > 0.0 ? 1.0 / S.inv_len[row] : 0.0;
  out[2] = S.built[row];
  out[3] = S.worst[2 * row];
  out[4] = S.worst[2 * row + 1];
  return 0;
}

/// Bytes the display segments hold.
SDNAP_EXPORT("sdnap_segments_bytes")
double sdnap_segments_bytes(void) { return static_cast<double>(sdnap::segments::seg_bytes()); }
