// -----------------------------------------------------------------------------
// SDN-AP 5.2.2 (DESIGN section 5): osculating (Cowell) integration in the
// module, the hand-off below the averaging limits and the events' reference:
// the TEME state (km, km/s) under the Earth's field to degree 20 (EGM96), the
// Sun and Moon of SPEC 5 as point masses, drag on NRLMSISE-00 x exp(s(t)) (the
// same environment as SDN-AP: $SPW, $DCL) with B_eff and a co-rotating
// atmosphere, and radial SRP (AGOM) with a cylindrical shadow; RK4 on a fixed
// node grid. Impulses (UVW of the state at their epoch) and constant-UVW
// finite burns split the integration at their epochs.
// -----------------------------------------------------------------------------

namespace sdnap {
namespace osc {

struct Burn {
  double t0 = 0.0, t1 = 0.0;   ///< s from the epoch (t1 == t0: an impulse)
  double uvw[3] = {0, 0, 0};   ///< impulse km/s, or acceleration km/s^2 for t1 > t0
};

struct Model {
  double jd_whole = 0.0, jd_frac = 0.0;  ///< the epoch (UTC split Julian date)
  double bterm = 0.0;                    ///< B_eff = C_D A / m, m^2/kg
  double agom = 0.0;                     ///< C_R A / m, m^2/kg
  bool drag = true, srp = true, third = true;
  const double* accel_uvw = nullptr;     ///< a finite burn's acceleration while it burns (km/s^2), else null
  double sustained_v = 0.0;              ///< a sustained transverse acceleration (km/s^2): a lowering set's tau0 (2c.2)
};

constexpr int kDegree = 20;  ///< the Earth's field: degree and order
constexpr double kMuSun = 1.32712440018e11, kMuMoon = 4902.800066;

inline void accel(const Model& m, double t, const double* r, const double* v, double* a) {
  const double mu = events::mu_xp(), R = xpt::kRe;
  const double r2 = r[0] * r[0] + r[1] * r[1] + r[2] * r[2], rn = std::sqrt(r2);
  for (int c = 0; c < 3; ++c) a[c] = -mu * r[c] / (r2 * rn);
  // the Earth's field to degree and order kDegree (EGM96, the module's fully normalized kEgmC / kEgmS) in Earth-fixed
  // axes (GMST): the V / W recursion of Montenbruck & Gill (2000, 3.2.4-3.2.5) on unnormalized coefficients
  {
    constexpr int N = kDegree;
    const double theta = gmst(m.jd_whole, m.jd_frac + t / 86400.0), ct = std::cos(theta), st = std::sin(theta);
    const double x = ct * r[0] + st * r[1], y = -st * r[0] + ct * r[1], z = r[2];
    const double rho = R * R / r2, x0 = R * x / r2, y0 = R * y / r2, z0 = R * z / r2;
    double V[N + 2][N + 2], W[N + 2][N + 2];
    V[0][0] = R / rn;
    W[0][0] = 0.0;
    V[1][0] = z0 * V[0][0];
    W[1][0] = 0.0;
    for (int n = 2; n <= N + 1; ++n) {
      V[n][0] = ((2.0 * n - 1.0) * z0 * V[n - 1][0] - (n - 1.0) * rho * V[n - 2][0]) / n;
      W[n][0] = 0.0;
    }
    for (int mm = 1; mm <= N + 1; ++mm) {
      V[mm][mm] = (2.0 * mm - 1.0) * (x0 * V[mm - 1][mm - 1] - y0 * W[mm - 1][mm - 1]);
      W[mm][mm] = (2.0 * mm - 1.0) * (x0 * W[mm - 1][mm - 1] + y0 * V[mm - 1][mm - 1]);
      if (mm <= N) {
        V[mm + 1][mm] = (2.0 * mm + 1.0) * z0 * V[mm][mm];
        W[mm + 1][mm] = (2.0 * mm + 1.0) * z0 * W[mm][mm];
      }
      for (int n = mm + 2; n <= N + 1; ++n) {
        V[n][mm] = ((2.0 * n - 1.0) * z0 * V[n - 1][mm] - (n + mm - 1.0) * rho * V[n - 2][mm]) / (n - mm);
        W[n][mm] = ((2.0 * n - 1.0) * z0 * W[n - 1][mm] - (n + mm - 1.0) * rho * W[n - 2][mm]) / (n - mm);
      }
    }
    double ax = 0.0, ay = 0.0, az = 0.0;
    for (int n = 2; n <= N; ++n) {
      for (int mm = 0; mm <= n; ++mm) {
        // the unnormalized coefficients: C_nm = N_nm Cbar_nm, N_nm = sqrt((2 - delta_m0)(2n + 1)(n - m)! / (n + m)!)
        double fac = 1.0;
        for (int q = n - mm + 1; q <= n + mm; ++q) fac *= q;
        const double Nnm = std::sqrt((mm == 0 ? 1.0 : 2.0) * (2.0 * n + 1.0) / fac);
        const double C = Nnm * xpt::tess::kEgmC[n][mm], S = Nnm * xpt::tess::kEgmS[n][mm];
        if (mm == 0) {
          ax -= C * V[n + 1][1];
          ay -= C * W[n + 1][1];
          az -= (n + 1.0) * C * V[n + 1][0];
        } else {
          const double f = (n - mm + 2.0) * (n - mm + 1.0);
          ax += 0.5 * ((-C * V[n + 1][mm + 1] - S * W[n + 1][mm + 1]) + f * (C * V[n + 1][mm - 1] + S * W[n + 1][mm - 1]));
          ay += 0.5 * ((-C * W[n + 1][mm + 1] + S * V[n + 1][mm + 1]) + f * (-C * W[n + 1][mm - 1] + S * V[n + 1][mm - 1]));
          az += (n - mm + 1.0) * (-C * V[n + 1][mm] - S * W[n + 1][mm]);
        }
      }
    }
    const double g = mu / (R * R);
    ax *= g; ay *= g; az *= g;
    a[0] += ct * ax - st * ay;
    a[1] += st * ax + ct * ay;
    a[2] += az;
  }
  const double d50 = (m.jd_whole - kJd1950) + m.jd_frac + t / 86400.0;
  if (m.third || m.srp) {
    const xpt::Bodies b = xpt::bodies_at(d50);
    const double rs[3] = {b.sun_u.x * b.sun_r * R, b.sun_u.y * b.sun_r * R, b.sun_u.z * b.sun_r * R};
    const double rm[3] = {b.moon_u.x * b.moon_r * R, b.moon_u.y * b.moon_r * R, b.moon_u.z * b.moon_r * R};
    if (m.third) {
      const double* rb[2] = {rs, rm};
      const double mb[2] = {kMuSun, kMuMoon};
      for (int j = 0; j < 2; ++j) {
        const double d[3] = {rb[j][0] - r[0], rb[j][1] - r[1], rb[j][2] - r[2]};
        const double dn = std::sqrt(d[0] * d[0] + d[1] * d[1] + d[2] * d[2]);
        const double bn = std::sqrt(rb[j][0] * rb[j][0] + rb[j][1] * rb[j][1] + rb[j][2] * rb[j][2]);
        for (int c = 0; c < 3; ++c) a[c] += mb[j] * (d[c] / (dn * dn * dn) - rb[j][c] / (bn * bn * bn));
      }
    }
    if (m.srp && m.agom != 0.0) {
      const double sn = std::sqrt(rs[0] * rs[0] + rs[1] * rs[1] + rs[2] * rs[2]);
      const double su[3] = {rs[0] / sn, rs[1] / sn, rs[2] / sn};
      const double along = r[0] * su[0] + r[1] * su[1] + r[2] * su[2];
      const double perp2 = r2 - along * along;
      const bool shadow = along < 0.0 && perp2 < R * R;  // cylindrical shadow of radius R_E
      if (!shadow) {
        const double d[3] = {r[0] - rs[0], r[1] - rs[1], r[2] - rs[2]};
        const double dn = std::sqrt(d[0] * d[0] + d[1] * d[1] + d[2] * d[2]), au = dn / 1.495978707e8;
        const double f = 4.56e-6 * m.agom / (1000.0 * au * au);
        for (int c = 0; c < 3; ++c) a[c] += f * d[c] / dn;
      }
    }
  }
  if (m.drag && m.bterm != 0.0) {
    const double theta = gmst(m.jd_whole, m.jd_frac + t / 86400.0);
    double lon = std::atan2(r[1], r[0]) - theta;
    lon -= kTwoPi * std::floor((lon + kPi) / kTwoPi);
    double phi, h;
    drag::geodetic(r[0] / R, r[1] / R, r[2] / R, phi, h);
    if (h < 2500.0) {
      double D, N;
      drag::day_of_year(d50, D, N);
      const int doy = static_cast<int>(std::floor(D)) + 1;
      const double sec = (D - std::floor(D)) * 86400.0;
      const double rho = sdn::msis_density(phi, lon, h, doy, sec, d50);
      const double vr[3] = {v[0] + kEarthRotationRate * r[1], v[1] - kEarthRotationRate * r[0], v[2]};
      const double vn = std::sqrt(vr[0] * vr[0] + vr[1] * vr[1] + vr[2] * vr[2]);
      const double f = -0.5 * rho * m.bterm * vn * 1000.0;
      for (int c = 0; c < 3; ++c) a[c] += f * vr[c];
    }
  }
  if (m.accel_uvw != nullptr) {
    double dv[3];
    events::uvw_to_teme(r, v, m.accel_uvw, dv);
    for (int c = 0; c < 3; ++c) a[c] += dv[c];
  }
  if (m.sustained_v != 0.0) {
    const double uvw[3] = {0.0, m.sustained_v, 0.0};
    double dv[3];
    events::uvw_to_teme(r, v, uvw, dv);
    for (int c = 0; c < 3; ++c) a[c] += dv[c];
  }
}

/// States (stride 6) at ascending times t (s from the epoch, >= 0) from the epoch state y0, the burns applied in
/// time order (impulses at their epochs, finite burns as constant UVW accelerations between t0 and t1); RK4 at h s
/// on each piece between consecutive events. False on a non-finite state.
inline bool states(const Model& base, const double* y0, const Burn* burns, int nb, const double* t, int count, double* out, double h = 10.0) {
  // event epochs in order
  std::vector<double> cuts;
  for (int j = 0; j < nb; ++j) { cuts.push_back(burns[j].t0); if (burns[j].t1 > burns[j].t0) cuts.push_back(burns[j].t1); }
  std::sort(cuts.begin(), cuts.end());
  double y[6], tc = 0.0;
  for (int c = 0; c < 6; ++c) y[c] = y0[c];
  int k = 0;
  auto piece = [&](double t_end, const double* accel_uvw) -> bool {
    // the times in [tc, t_end) from this piece, then the state at t_end
    Model m = base;
    m.accel_uvw = accel_uvw;
    auto f = [&](double tt, const double* s, double* d) {
      double a[3];
      accel(m, tc + tt, s, s + 3, a);
      for (int c = 0; c < 3; ++c) { d[c] = s[3 + c]; d[3 + c] = a[c]; }
    };
    std::vector<double> ts;
    const int first = k;
    while (k < count && t[k] < t_end) ts.push_back(t[k++] - tc);
    ts.push_back(t_end - tc);
    std::vector<double> o(6 * ts.size());
    if (!segment::rk4_states(f, y, h, ts.data(), static_cast<int>(ts.size()), o.data(), 6)) return false;
    for (int j = first; j < k; ++j)
      for (int c = 0; c < 6; ++c) out[6 * j + c] = o[6 * (j - first) + c];
    for (int c = 0; c < 6; ++c) y[c] = o[6 * (ts.size() - 1) + c];
    tc = t_end;
    return true;
  };
  for (const double cut : cuts) {
    if (cut <= tc) continue;
    // the acceleration in force on [tc, cut): a finite burn spanning it
    const double* acc = nullptr;
    for (int j = 0; j < nb; ++j) if (burns[j].t1 > burns[j].t0 && burns[j].t0 <= tc && burns[j].t1 >= cut) acc = burns[j].uvw;
    if (!piece(cut, acc)) return false;
    for (int j = 0; j < nb; ++j)
      if (burns[j].t1 == burns[j].t0 && burns[j].t0 == cut) {
        double dv[3];
        events::uvw_to_teme(y, y + 3, burns[j].uvw, dv);
        for (int c = 0; c < 3; ++c) y[3 + c] += dv[c];
      }
  }
  const double t_last = count > 0 ? t[count - 1] : tc;
  if (k < count) {
    const double* acc = nullptr;
    for (int j = 0; j < nb; ++j) if (burns[j].t1 > burns[j].t0 && burns[j].t0 <= tc && burns[j].t1 > tc) acc = burns[j].uvw;
    if (!piece(t_last + 1e-9, acc)) return false;
  }
  return true;
}

}  // namespace osc
}  // namespace sdnap

/// Diagnostic and the events' reference (5.2.2): osculating states at `t` (s from the UTC epoch whole + frac,
/// ascending, >= 0) from the TEME state `y0` (km, km/s) with B_eff `bterm` and `agom` (m^2/kg); `burns`: nb records
/// of 5 doubles (t0 s, t1 s, u, v, w: an impulse in km/s when t1 == t0, else a constant UVW acceleration in km/s^2);
/// `flags` 1 no drag, 2 no SRP, 4 no third bodies; RK4 at `step` s. Writes 6 doubles per time; returns 0 or -1.
SDNAP_EXPORT("sdnap_osculating_states")
int32_t sdnap_osculating_states(double whole, double frac, const double* y0, double bterm, double agom, int32_t flags, const double* burns,
                                int32_t nb, const double* t, int32_t count, double* out, double step) {
  using namespace sdnap::osc;
  Model m;
  m.jd_whole = whole;
  m.jd_frac = frac;
  m.bterm = bterm;
  m.agom = agom;
  m.drag = !(flags & 1);
  m.srp = !(flags & 2);
  m.third = !(flags & 4);
  std::vector<Burn> b(nb > 0 ? nb : 0);
  for (int j = 0; j < nb; ++j) {
    b[j].t0 = burns[5 * j];
    b[j].t1 = burns[5 * j + 1];
    for (int c = 0; c < 3; ++c) b[j].uvw[c] = burns[5 * j + 2 + c];
  }
  sdnap::drag::table();
  return states(m, y0, b.data(), nb, t, count, out, step > 0.0 ? step : 10.0) ? 0 : -1;
}
