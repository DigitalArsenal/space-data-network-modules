// -----------------------------------------------------------------------------
// SGP4XP's selectable drag atmosphere (side B's option, outside the SGP4-XP
// specification; SPEC 15). With no atmosphere (nullptr) the drag is the
// theory's own (SPEC 3: Jacchia 1970 on the generic flux model). A `fit` or
// `propagate` whose $PCF FORCES selects another gives the call an Atmosphere
// (atmosphere_inputs.inc reads it from the call's frames):
//   - Jacchia 1970 (SPEC 3.2, 3.3) on measured drivers from $SPW rows;
//   - NRLMSISE-00 on those drivers: gtd7d of the public-domain Brodowski C port
//     in third_party/nrlmsise00 (consumed as it is, SHA-256 pinned by
//     build.mjs), total mass density with anomalous oxygen, every switch 1 but
//     the output units (the daily-Ap form), as propagator/ffm and
//     analysis/density-calibration drive it;
//   - NRLMSISE-00 times exp(s(t)), s the open-DCA common mode of a $DCL.
// Every set initialized during the call carries the call's atmosphere
// (RateContext); one initialized elsewhere (the ABI, the epoch store) carries
// none. NRLMSISE-00 keeps file-static state, so the atmosphere is evaluated on
// the calling thread only: the invoke methods that select it are single-threaded.
// -----------------------------------------------------------------------------

#include "nrlmsise00.h"
#ifdef __wasm_simd128__
#include <wasm_simd128.h>
#endif

namespace sdnap {
namespace atm {

/// One daily $SPW row as NRLMSISE-00 reads it: the UTC day (MJD), the observed F10.7, its 81-day centered mean and
/// the daily Ap; with the row's DATE as written and its F107_DATA_TYPE, which an $OCM carries (SPEC 15).
struct SpwDay {
  int32_t mjd;
  double f107_obs, f107_center81, ap_avg;
  int8_t data_type;  ///< F107DataType: OBS observed; INT, PRD, PRM not
  char date[32];     ///< DATE as the row wrote it
};

enum Model : int32_t { kJacchia70 = 0, kNrlmsise00 = 1 };

struct Atmosphere {
  Model model = kJacchia70;
  bool measured = false;               ///< drivers from `days` (else SPEC 3.1's generic flux model; Jacchia 1970 only)
  std::vector<SpwDay> days;            ///< ascending MJD, one row per day
  std::vector<double> dca_d50, dca_s;  ///< open-DCA nodes (days from 1950 January 0.0 UTC) and s = ln(rho / rho_NRLMSISE-00)
  std::vector<int64_t> dca_ms;         ///< the nodes as UTC Unix milliseconds
  std::string dcl_cid;                 ///< CID of the $DCL the nodes came from
  std::string source_id;               ///< the rows' PVN.SOURCE_ID (the first row naming one)
  mutable int32_t min_driver_mjd = std::numeric_limits<int32_t>::min();  ///< earliest required driver MJD (earliest state's MJD - 1)
  mutable bool before_rows = false;    ///< an evaluation asked for a day before the first row (the call is refused)
};

/// The atmosphere of the call in progress (nullptr: the theory's own); xp_init gives it to the set.
inline const Atmosphere*& active() {
  static const Atmosphere* a = nullptr;
  return a;
}

/// The row in force on UTC day `mjd`: the last row at or before it, so past the last row that row holds (HOLD_LAST);
/// before the first row the first, and the call is refused (before_rows) when `mjd >= a.min_driver_mjd`.
inline const SpwDay& row_at(const Atmosphere& a, int32_t mjd) {
  const std::vector<SpwDay>& d = a.days;
  size_t lo = 0, hi = d.size();
  while (lo < hi) {
    const size_t mid = (lo + hi) / 2;
    if (d[mid].mjd <= mjd) lo = mid + 1;
    else hi = mid;
  }
  if (lo == 0) {
    if (mjd >= a.min_driver_mjd) a.before_rows = true;
    return d[0];
  }
  return d[lo - 1];
}

/// The drivers at d50 (days from 1950 January 0.0 UTC), NRLMSISE-00's daily-Ap convention: F10.7 the observed flux of
/// the previous UTC day, F10.7a the 81-day centered mean of the day, Ap the daily Ap of the day. In SPEC 3.2 they are F,
/// F-bar and Ap.
inline drag::Flux drivers_at(const Atmosphere& a, double d50) {
  const int32_t mjd = static_cast<int32_t>(std::floor(d50 + 33281.0));  // MJD = d50 + (2433281.5 - 2400000.5)
  drag::Flux f{};
  f.f = row_at(a, mjd - 1).f107_obs;
  const SpwDay& day = row_at(a, mjd);
  f.fbar = day.f107_center81;
  f.ap = day.ap_avg;
  return f;
}

/// exp(s(t)) of the open DCA: s linear in UTC between the $DCL's nodes, held at the end values outside them (the
/// producer's forecast nodes carry its decay; no second one applies).
inline double dca_scale(const Atmosphere& a, double d50) {
  const std::vector<double>& t = a.dca_d50;
  const std::vector<double>& s = a.dca_s;
  double v;
  if (d50 <= t.front()) {
    v = s.front();
  } else if (d50 >= t.back()) {
    v = s.back();
  } else {
    size_t lo = 0, hi = t.size() - 1;
    while (hi - lo > 1) {
      const size_t mid = (lo + hi) / 2;
      if (t[mid] <= d50) lo = mid;
      else hi = mid;
    }
    const double w = (d50 - t[lo]) / (t[hi] - t[lo]);
    v = s[lo] * (1.0 - w) + s[hi] * w;
  }
  return std::exp(v);
}

inline double fast_ccor_log(double alt, double r, double h1, double zh) {
  const double e = (alt - zh) / h1;
  if (e > 70.0) return 0.0;
  if (e < -70.0) return r;
  return r / (1.0 + fm::exp(e));
}

inline double fast_ccor(double alt, double r, double h1, double zh) {
  return fm::exp(fast_ccor_log(alt, r, h1, zh));
}

inline double fast_ccor2_log(double alt, double r, double h1, double zh, double h2) {
  const double e1 = (alt - zh) / h1;
  const double e2 = (alt - zh) / h2;
  if (e1 > 70.0 || e2 > 70.0) return 0.0;
  if (e1 < -70.0 && e2 < -70.0) return r;
#ifdef __wasm_simd128__
  const v128_t ve = fm::exp2_f64x2(wasm_f64x2_make(e1, e2));
  return r / (1.0 + 0.5 * (wasm_f64x2_extract_lane(ve, 0) + wasm_f64x2_extract_lane(ve, 1)));
#else
  return r / (1.0 + 0.5 * (fm::exp(e1) + fm::exp(e2)));
#endif
}

inline double fast_ccor2(double alt, double r, double h1, double zh, double h2) {
  return fm::exp(fast_ccor2_log(alt, r, h1, zh, h2));
}

struct ThermoStatic {
  bool ready = false;
  const double* p[11]{};
  double ph_c0[11]{}, ph_s0[11]{};
  double ph_c2[11]{}, ph_s2[11]{};
  double ph_c3[11]{}, ph_s3[11]{};
  double ph_c4[11]{}, ph_s4[11]{};
  double ph_c5[11]{}, ph_s5[11]{};
  double ph_c6[11]{}, ph_s6[11]{};
  double base_pt = 0.0, base_ps = 0.0, base_tlb = 0.0;
  double dlb0[8]{};  // n2, he, o, o2, ar, h, n, ao
  double tho = 0.0, zsht = 0.0, zmho = 0.0;
  double hcc32 = 0.0, hcc232 = 0.0, zcc32 = 0.0, rc32_0 = 0.0, rc32_dfa = 0.0;
  double za = 0.0, zlb = 0.0, xmm = 0.0, zhm28 = 0.0, zh14 = 0.0, pdm22 = 0.0, pdl1_24 = 0.0, pdl0_24 = 0.0;
  double inv_tn1[5]{}, tgn1_1 = 0.0;
  double n14_mix = 0.0, log_dlb28_14_mix = 0.0, hc14 = 0.0, zc14 = 0.0, hcc14 = 0.0, zcc14 = 0.0, rc14 = 0.0;
  double a_net = 0.0, inv_a_net = 0.0, inv_hc14 = 0.0, inv_hcc14 = 0.0;
  double s14_c = 0.0, s14_ys = 0.0, s14_yd = 0.0;
  double s28_p[3][4]{};
  double glb_p[4]{};
  float zmho_fac_p[4]{};
  float rzlb_za_p[4]{};
  float zgdif_p[4]{};
  float gamm1_p[4]{};
};

inline thread_local ThermoStatic g_thermo_static{};

[[gnu::noinline]] inline void init_thermo_static(ThermoStatic& s) {
  constexpr double hr = 0.2618, sr = 7.2722E-5, dgtr = 1.74533E-2;
  s.p[0] = nrlmsise00::pt;
  s.p[1] = nrlmsise00::ps;
  s.p[2] = nrlmsise00::pd[3];
  s.p[3] = nrlmsise00::pd[2];
  s.p[4] = nrlmsise00::pd[0];
  s.p[5] = nrlmsise00::pd[1];
  s.p[6] = nrlmsise00::pd[4];
  s.p[7] = nrlmsise00::pd[5];
  s.p[8] = nrlmsise00::pd[6];
  s.p[9] = nrlmsise00::pd[7];
  s.p[10] = nrlmsise00::pd[8];
  for (int k = 0; k < 11; ++k) {
    const double* pk = s.p[k];
    s.ph_c0[k] = std::cos(hr * pk[124]);
    s.ph_s0[k] = std::sin(hr * pk[124]);
    s.ph_c2[k] = std::cos(sr * pk[71]);
    s.ph_s2[k] = std::sin(sr * pk[71]);
    s.ph_c3[k] = std::cos(sr * pk[79]);
    s.ph_s3[k] = std::sin(sr * pk[79]);
    s.ph_c4[k] = std::cos(dgtr * pk[63]);
    s.ph_s4[k] = std::sin(dgtr * pk[63]);
    s.ph_c5[k] = std::cos(dgtr * pk[118]);
    s.ph_s5[k] = std::sin(dgtr * pk[118]);
    s.ph_c6[k] = std::cos(sr * pk[75]);
    s.ph_s6[k] = std::sin(sr * pk[75]);
  }
  s.base_pt = nrlmsise00::ptm[0] * nrlmsise00::pt[0];
  s.base_ps = nrlmsise00::ptm[3] * nrlmsise00::ps[0];
  s.base_tlb = nrlmsise00::ptm[1] * nrlmsise00::pd[3][0];
  s.dlb0[0] = nrlmsise00::pdm[2][0] * nrlmsise00::pd[2][0];
  s.dlb0[1] = nrlmsise00::pdm[0][0] * nrlmsise00::pd[0][0];
  s.dlb0[2] = nrlmsise00::pdm[1][0] * nrlmsise00::pd[1][0];
  s.dlb0[3] = nrlmsise00::pdm[3][0] * nrlmsise00::pd[4][0];
  s.dlb0[4] = nrlmsise00::pdm[4][0] * nrlmsise00::pd[5][0];
  s.dlb0[5] = nrlmsise00::pdm[5][0] * nrlmsise00::pd[6][0];
  s.dlb0[6] = nrlmsise00::pdm[6][0] * nrlmsise00::pd[7][0];
  s.dlb0[7] = nrlmsise00::pdm[7][0] * nrlmsise00::pd[8][0];
  s.tho = nrlmsise00::pdm[7][9] * nrlmsise00::pdl[0][6];
  s.zsht = nrlmsise00::pdm[7][5];
  s.zmho = nrlmsise00::pdm[7][4];
  s.hcc32 = nrlmsise00::pdm[3][7] * nrlmsise00::pdl[1][22];
  s.hcc232 = nrlmsise00::pdm[3][7] * nrlmsise00::pdl[0][22];
  s.zcc32 = nrlmsise00::pdm[3][6] * nrlmsise00::pdl[1][21];
  s.rc32_0 = nrlmsise00::pdm[3][3] * nrlmsise00::pdl[1][23];
  s.rc32_dfa = nrlmsise00::pdl[0][23];
  s.za = nrlmsise00::pdl[1][15];
  s.zlb = nrlmsise00::ptm[5];
  s.xmm = nrlmsise00::pdm[2][4];
  s.zhm28 = nrlmsise00::pdm[2][3] * nrlmsise00::pdl[1][5];
  s.zh14 = nrlmsise00::pdm[6][2];
  s.pdm22 = nrlmsise00::pdm[2][2];
  s.pdl1_24 = nrlmsise00::pdl[1][24];
  s.pdl0_24 = nrlmsise00::pdl[0][24];
  s.inv_tn1[0] = 0.0;
  s.inv_tn1[1] = 1.0 / (nrlmsise00::ptm[6] * nrlmsise00::ptl[0][0]);
  s.inv_tn1[2] = 1.0 / (nrlmsise00::ptm[2] * nrlmsise00::ptl[1][0]);
  s.inv_tn1[3] = 1.0 / (nrlmsise00::ptm[7] * nrlmsise00::ptl[2][0]);
  s.inv_tn1[4] = 1.0 / (nrlmsise00::ptm[4] * nrlmsise00::ptl[3][0]);
  s.tgn1_1 = nrlmsise00::ptm[8] * nrlmsise00::pma[8][0];
  s.n14_mix = nrlmsise00::pdm[6][1] * std::fabs(nrlmsise00::pdl[0][2]);
  s.log_dlb28_14_mix = std::log(s.dlb0[0] * s.n14_mix / s.dlb0[6]);
  s.hc14 = nrlmsise00::pdm[6][5] * nrlmsise00::pdl[0][1];
  s.zc14 = nrlmsise00::pdm[6][4] * nrlmsise00::pdl[0][0];
  s.hcc14 = nrlmsise00::pdm[6][7] * nrlmsise00::pdl[0][4];
  s.zcc14 = nrlmsise00::pdm[6][6] * nrlmsise00::pdl[0][3];
  s.rc14 = nrlmsise00::pdm[6][3] * nrlmsise00::pdl[0][5];
  s.a_net = s.zhm28 / (s.xmm - 14.0);
  s.inv_a_net = 1.0 / s.a_net;
  s.inv_hc14 = 1.0 / s.hc14;
  s.inv_hcc14 = 1.0 / s.hcc14;
  {
    constexpr double re0 = 6367.43;
    constexpr double zn1[5] = {0.0, 110.0, 100.0, 90.0, 72.5};
    const double z1 = s.za, z2 = 72.5;
    const double zgdif0 = (z2 - z1) * (re0 + z1) / (re0 + z2);
    const double r_z2_z1 = (re0 + z2) / (re0 + z1);
    double xs[5];
    xs[0] = 0.0;
    for (int k_sp = 1; k_sp < 4; ++k_sp) {
      xs[k_sp] = ((zn1[k_sp] - z1) * (re0 + z1) / (re0 + zn1[k_sp])) / zgdif0;
    }
    xs[4] = 1.0;
    const double yd2_0 = -s.tgn1_1 * (s.inv_tn1[4] * s.inv_tn1[4]) * zgdif0 * (r_z2_z1 * r_z2_z1);
    auto eval_basis = [&](int b, double x_val) -> double {
      double ys[5]{}, y2[5]{}, u_sp[5]{};
      double yd1 = 0.0, yd2 = 0.0;
      if (b == 0) {
        for (int k_sp = 1; k_sp <= 4; ++k_sp) ys[k_sp] = s.inv_tn1[k_sp];
        yd2 = yd2_0;
      } else if (b == 1) {
        ys[0] = 1.0;
      } else {
        yd1 = 1.0;
      }
      y2[0] = -0.5;
      u_sp[0] = (3.0 / xs[1]) * ((ys[1] - ys[0]) / xs[1] - yd1);
      for (int i = 1; i < 4; ++i) {
        const double sig = (xs[i] - xs[i - 1]) / (xs[i + 1] - xs[i - 1]);
        const double p_sp = sig * y2[i - 1] + 2.0;
        y2[i] = (sig - 1.0) / p_sp;
        u_sp[i] = (6.0 * ((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]) - (ys[i] - ys[i - 1]) / (xs[i] - xs[i - 1])) /
                       (xs[i + 1] - xs[i - 1]) -
                   sig * u_sp[i - 1]) /
                  p_sp;
      }
      const double dx34 = xs[4] - xs[3];
      const double un = (3.0 / dx34) * (yd2 - (ys[4] - ys[3]) / dx34);
      y2[4] = (un - 0.5 * u_sp[3]) / (0.5 * y2[3] + 1.0);
      for (int k_sp = 3; k_sp >= 0; --k_sp) y2[k_sp] = y2[k_sp] * y2[k_sp + 1] + u_sp[k_sp];
      double yi = 0.0;
      int klo = 0, khi = 1;
      while (x_val > xs[klo] && khi < 5) {
        double xx = x_val;
        if (khi < 4 && x_val >= xs[khi]) xx = xs[khi];
        const double hh = xs[khi] - xs[klo];
        const double aa = (xs[khi] - xx) / hh;
        const double bb_v = (xx - xs[klo]) / hh;
        const double a2 = aa * aa, b2 = bb_v * bb_v;
        yi += ((1.0 - a2) * ys[klo] * 0.5 + b2 * ys[khi] * 0.5 +
               ((-(1.0 + a2 * a2) * 0.25 + a2 * 0.5) * y2[klo] + (b2 * b2 * 0.25 - b2 * 0.5) * y2[khi]) * hh * hh *
                   (1.0 / 6.0)) *
              hh;
        ++klo;
        ++khi;
      }
      return yi;
    };
    const double x14 = ((s.zh14 - z1) * (re0 + z1) / (re0 + s.zh14)) / zgdif0;
    s.s14_c = eval_basis(0, x14);
    s.s14_ys = eval_basis(1, x14);
    s.s14_yd = eval_basis(2, x14);
    constexpr double ca = 0.9238795325112867561, cb = 0.3826834323650897717;
    constexpr double ca2 = ca * ca, cb2 = cb * cb, inv_dab = 1.0 / (ca2 - cb2);
    auto x28_of = [&](double u) -> double {
      const double zh28 = s.pdm22 * s.pdl1_24 * (1.0 + s.pdl0_24 * u);
      return ((zh28 - z1) * (re0 + z1) / (re0 + zh28)) / zgdif0;
    };
    for (int b = 0; b < 3; ++b) {
      const double fa_p = eval_basis(b, x28_of(ca)), fa_m = eval_basis(b, x28_of(-ca));
      const double fb_p = eval_basis(b, x28_of(cb)), fb_m = eval_basis(b, x28_of(-cb));
      const double even_a = 0.5 * (fa_p + fa_m), even_b = 0.5 * (fb_p + fb_m);
      const double odd_a = 0.5 * (fa_p - fa_m) / ca, odd_b = 0.5 * (fb_p - fb_m) / cb;
      const double p2 = (even_a - even_b) * inv_dab;
      const double p0 = even_b - p2 * cb2;
      const double p3 = (odd_a - odd_b) * inv_dab;
      const double p1 = odd_b - p3 * cb2;
      s.s28_p[b][0] = p0;
      s.s28_p[b][1] = p1;
      s.s28_p[b][2] = p2;
      s.s28_p[b][3] = p3;
    }
    auto gsurf_of = [](double u) -> double { return 980.616 * (1.0 - 0.0026373 * u); };
    auto re_of = [&](double u) -> double {
      const double x_re = (2.27E-9 / 3.085462E-6) * u;
      return gsurf_of(u) * (2.0E-5 / 3.085462E-6) * (1.0 - x_re * (1.0 - x_re));
    };
    auto fit4_d = [&](auto&& fn, double out_p[4]) {
      const double fa_p = fn(ca), fa_m = fn(-ca), fb_p = fn(cb), fb_m = fn(-cb);
      const double even_a = 0.5 * (fa_p + fa_m), even_b = 0.5 * (fb_p + fb_m);
      const double odd_a = 0.5 * (fa_p - fa_m) / ca, odd_b = 0.5 * (fb_p - fb_m) / cb;
      const double p2 = (even_a - even_b) * inv_dab;
      out_p[0] = even_b - p2 * cb2;
      out_p[2] = p2;
      const double p3 = (odd_a - odd_b) * inv_dab;
      out_p[1] = odd_b - p3 * cb2;
      out_p[3] = p3;
    };
    auto fit4_f = [&](auto&& fn, float out_p[4]) {
      double tmp[4];
      fit4_d(fn, tmp);
      for (int q = 0; q < 4; ++q) out_p[q] = static_cast<float>(tmp[q]);
    };
    fit4_d([&](double u) {
      const double iz = 1.0 + s.zlb / re_of(u);
      return gsurf_of(u) / (iz * iz);
    }, s.glb_p);
    fit4_f([&](double u) {
      const double iz = 1.0 + s.zmho / re_of(u);
      return (gsurf_of(u) / (iz * iz)) * (16.0 * s.zsht / (831.4 * s.tho));
    }, s.zmho_fac_p);
    fit4_f([&](double u) {
      const double r = re_of(u);
      return (r + s.zlb) / (r + s.za);
    }, s.rzlb_za_p);
    fit4_f([&](double u) {
      const double r = re_of(u);
      return (72.5 - s.za) * (r + s.za) / (r + 72.5);
    }, s.zgdif_p);
    fit4_f([&](double u) {
      const double r = re_of(u);
      const double iz = 1.0 + s.za / r;
      const double glb_za = gsurf_of(u) / (iz * iz);
      const double zgdif = (72.5 - s.za) * (r + s.za) / (r + 72.5);
      return glb_za * zgdif * (1.0 / 831.4);
    }, s.gamm1_p);
  }
  s.ready = true;
}

inline const ThermoStatic& thermo_static() {
  ThermoStatic& ts = g_thermo_static;
  if (__builtin_expect(!ts.ready, 0)) init_thermo_static(ts);
  return ts;
}

struct ThermoTimeCache {
  alignas(16) double wd_const[4]{};
  alignas(16) double Wd[58][4]{};
  alignas(16) float wf_const[8]{};
  alignas(16) float Wf[58][8]{};
  alignas(16) float Wf12[58][12]{};
  double g_const[11]{};
  double d50 = -1e30;
  int doy = -1;
  double sec = 0.0;
  double sec_hr = 0.0;
  double csec = 1.0, ssec = 0.0;
  double ch_ut = 1.0, sh_ut = 0.0;
  double c_ut_pi12 = 1.0, s_ut_pi12 = 0.0;
  int drv_doy = -1;
  double drv_f = -1e30, drv_fbar = -1e30, drv_ap = -1e30;
  double dfa = 0.0;
  double cd14_0 = 1.0;
  double apdf[11]{};
  double w_day_p01[11]{}, w_day_p03[11]{}, w_day_p05[11]{};
  double ut11_fac[11]{}, b1_11[11]{}, b2_11[11]{};
};

inline thread_local ThermoTimeCache g_thermo_time_cache{};

inline void set_thermo_w(ThermoTimeCache& tc, int m, int k, double val) {
  tc.Wf12[m][k] = static_cast<float>(val);
  if (k < 4) tc.Wd[m][k] = val;
  else tc.Wf[m][k - 4] = static_cast<float>(val);
}

inline const ThermoTimeCache& prepare_msis_time(double d50, const drag::Flux& f) {
  constexpr double sr = 7.2722E-5, dr = 1.72142E-2, hr = 0.2618;
  const ThermoStatic& ts = thermo_static();
  ThermoTimeCache& tc = g_thermo_time_cache;
  bool sec_changed = false;
  if (tc.d50 != d50) {
    double D, N;
    drag::day_of_year(d50, D, N);
    const double day = std::floor(D);
    tc.d50 = d50;
    tc.doy = static_cast<int>(day) + 1;
    tc.sec = (D - day) * 86400.0;
    tc.sec_hr = tc.sec * (1.0 / 3600.0);
    fm::sincos(sr * tc.sec, tc.ssec, tc.csec);
    fm::sincos(hr * tc.sec_hr, tc.sh_ut, tc.ch_ut);
    fm::sincos((kPi / 12.0) * tc.sec_hr, tc.s_ut_pi12, tc.c_ut_pi12);
    sec_changed = true;
  }
  if (tc.drv_doy != tc.doy || tc.drv_f != f.f || tc.drv_fbar != f.fbar || tc.drv_ap != f.ap) {
    tc.drv_doy = tc.doy;
    tc.drv_f = f.f;
    tc.drv_fbar = f.fbar;
    tc.drv_ap = f.ap;
    const double df = f.f - f.fbar;
    const double dfa = f.fbar - 150.0;
    const double dfa2 = dfa * dfa;
    const double df2 = df * df;
    const double apd = f.ap - 4.0;
    tc.dfa = dfa;
    tc.wf_const[7] = 0.0f;
    for (int m = 0; m < 58; ++m) {
      tc.Wf[m][7] = 0.0f;
      tc.Wf12[m][11] = 0.0f;
    }
    for (int k = 0; k < 11; ++k) {
      const double* p = ts.p[k];
      double s_tmp, cd32, cd18, cd14, cd39;
      fm::sincos(dr * (tc.doy - p[31]), s_tmp, cd32);
      fm::sincos(2.0 * dr * (tc.doy - p[17]), s_tmp, cd18);
      fm::sincos(dr * (tc.doy - p[13]), s_tmp, cd14);
      fm::sincos(2.0 * dr * (tc.doy - p[38]), s_tmp, cd39);
      if (k == 0) tc.cd14_0 = cd14;
      double p44 = p[43];
      if (p44 < 0.0) p44 = 1.0E-5;
      const double apdf = apd + (p[44] - 1.0) * (apd + (std::exp(-p44 * apd) - 1.0) / p44);
      tc.apdf[k] = apdf;
      const double f_df = p[19] * df + p[20] * df2;
      const double t0 = p[19] * df * (1.0 + p[59] * dfa) + p[20] * df2 + p[21] * dfa + p[29] * dfa2;
      const double t0_2 = p[30] + t0 + p[18] * cd32;
      const double f1 = 1.0 + (p[47] * dfa + f_df);
      const double f2 = 1.0 + (p[49] * dfa + f_df);

      const double wc_val = t0_2 + p[15] * cd18 + apdf * p[32];
      tc.g_const[k] = wc_val;
      if (k < 4) tc.wd_const[k] = wc_val;
      else tc.wf_const[k - 4] = static_cast<float>(wc_val);
      tc.w_day_p01[k] = p[26] + f1 * p[9] * cd14 + p[37] * cd39 + apdf * p[100] * cd14;
      tc.w_day_p03[k] = (f1 * p[10] + apdf * p[101]) * cd14;
      tc.w_day_p05[k] = apdf * p[102] * cd14;
      tc.ut11_fac[k] = 1.0 + p[81] * dfa;
      tc.b1_11[k] = p[95] + p[119] * cd14;
      tc.b2_11[k] = p[95] * p[119] * cd14;

      set_thermo_w(tc, 1, k, p[1] + p[14] * dfa + p[16] * cd18 + apdf * p[45]);
      set_thermo_w(tc, 3, k, p[2] + apdf * p[34]);
      set_thermo_w(tc, 5, k, p[22]);

      const double ac0 = apdf * ts.ph_c0[k], as0 = apdf * ts.ph_s0[k];
      set_thermo_w(tc, 12, k, f2 * p[3] + ac0 * p[121]);
      set_thermo_w(tc, 13, k, f2 * p[11] * cd14);
      set_thermo_w(tc, 14, k, f2 * p[4] + ac0 * p[122]);
      set_thermo_w(tc, 15, k, f2 * p[27] + ac0 * p[123]);
      set_thermo_w(tc, 16, k, f2 * p[6] + as0 * p[121]);
      set_thermo_w(tc, 17, k, f2 * p[12] * cd14);
      set_thermo_w(tc, 18, k, f2 * p[7] + as0 * p[122]);
      set_thermo_w(tc, 19, k, f2 * p[28] + as0 * p[123]);

      set_thermo_w(tc, 20, k, f2 * p[5]);
      set_thermo_w(tc, 21, k, f2 * p[23] * cd14);
      set_thermo_w(tc, 22, k, f2 * p[41]);
      set_thermo_w(tc, 23, k, f2 * p[35] * cd14);
      set_thermo_w(tc, 24, k, f2 * p[8]);
      set_thermo_w(tc, 25, k, f2 * p[33] * cd14);
      set_thermo_w(tc, 26, k, f2 * p[42]);
      set_thermo_w(tc, 27, k, f2 * p[36] * cd14);

      set_thermo_w(tc, 28, k, f2 * p[39]);
      set_thermo_w(tc, 29, k, f2 * p[93] * cd14);
      set_thermo_w(tc, 30, k, f2 * p[46] * cd14);
      set_thermo_w(tc, 31, k, f2 * p[40]);
      set_thermo_w(tc, 32, k, f2 * p[94] * cd14);
      set_thermo_w(tc, 33, k, f2 * p[48] * cd14);

      const double g10 = 1.0 + p[80] * dfa;
      const double ac4 = apdf * ts.ph_c4[k], as4 = apdf * ts.ph_s4[k];
      const double ac5 = apdf * cd14 * ts.ph_c5[k], as5 = apdf * cd14 * ts.ph_s5[k];
      set_thermo_w(tc, 34, k, g10 * (p[103] + p[109] * cd14) + ac5 * p[115]);
      set_thermo_w(tc, 35, k, g10 * p[64] + ac4 * p[60]);
      set_thermo_w(tc, 36, k, g10 * (p[104] + p[110] * cd14) + ac5 * p[116]);
      set_thermo_w(tc, 37, k, g10 * p[65] + ac4 * p[61]);
      set_thermo_w(tc, 38, k, g10 * (p[105] + p[111] * cd14) + ac5 * p[117]);
      set_thermo_w(tc, 39, k, g10 * p[66] + ac4 * p[62]);
      set_thermo_w(tc, 40, k, ac4 * p[120] * p[60]);
      set_thermo_w(tc, 41, k, ac4 * p[120] * p[61]);
      set_thermo_w(tc, 42, k, ac4 * p[120] * p[62]);

      set_thermo_w(tc, 43, k, g10 * (p[106] + p[112] * cd14) + as5 * p[115]);
      set_thermo_w(tc, 44, k, g10 * p[90] + as4 * p[60]);
      set_thermo_w(tc, 45, k, g10 * (p[107] + p[113] * cd14) + as5 * p[116]);
      set_thermo_w(tc, 46, k, g10 * p[91] + as4 * p[61]);
      set_thermo_w(tc, 47, k, g10 * (p[108] + p[114] * cd14) + as5 * p[117]);
      set_thermo_w(tc, 48, k, g10 * p[92] + as4 * p[62]);
      set_thermo_w(tc, 49, k, as4 * p[120] * p[60]);
      set_thermo_w(tc, 50, k, as4 * p[120] * p[61]);
      set_thermo_w(tc, 51, k, as4 * p[120] * p[62]);

      const double m11_c = (1.0 + p[137] * dfa) * ts.ph_c3[k];
      const double m11_s = (1.0 + p[137] * dfa) * ts.ph_s3[k];
      set_thermo_w(tc, 52, k, m11_c * p[76]);
      set_thermo_w(tc, 53, k, m11_c * p[77]);
      set_thermo_w(tc, 54, k, m11_c * p[78]);
      set_thermo_w(tc, 55, k, m11_s * p[76]);
      set_thermo_w(tc, 56, k, m11_s * p[77]);
      set_thermo_w(tc, 57, k, m11_s * p[78]);
    }
    sec_changed = true;
  }
  if (sec_changed) {
    for (int k = 0; k < 11; ++k) {
      const double* p = ts.p[k];
      const double ut_c2 = tc.csec * ts.ph_c2[k] + tc.ssec * ts.ph_s2[k];
      const double ut_c6 = tc.apdf[k] * (tc.csec * ts.ph_c6[k] + tc.ssec * ts.ph_s6[k]);
      const double ut11 = tc.ut11_fac[k] * ut_c2;
      const double b1 = tc.b1_11[k], b2 = tc.b2_11[k];
      set_thermo_w(tc, 0, k, tc.w_day_p01[k] + ut11 * p[68] + ut_c6 * p[83]);
      set_thermo_w(tc, 2, k, tc.w_day_p03[k] + ut11 * p[69] + ut_c6 * p[84]);
      set_thermo_w(tc, 4, k, tc.w_day_p05[k] + ut11 * p[70] + ut_c6 * p[85]);
      set_thermo_w(tc, 6, k, ut11 * b1 * p[68]);
      set_thermo_w(tc, 7, k, ut11 * b1 * p[69]);
      set_thermo_w(tc, 8, k, ut11 * b1 * p[70]);
      set_thermo_w(tc, 9, k, ut11 * b2 * p[68]);
      set_thermo_w(tc, 10, k, ut11 * b2 * p[69]);
      set_thermo_w(tc, 11, k, ut11 * b2 * p[70]);
    }
  }
  return tc;
}

inline double msis_d7_lo_delta_log(const ThermoStatic& ts, const ThermoTimeCache& tc, double h, double c, double re,
                                   double gsurf, double tinf, double tlb, double s_grad, double gamma_1, double slope_xm,
                                   double g3, double g9) {
  const double za = ts.za, zlb = ts.zlb;
  const double zg2_za = (za - zlb) * (re + zlb) / (re + za);
  const double ta = tinf - (tinf - tlb) * fm::exp(-s_grad * zg2_za);
  const double r_zlb_za = (re + zlb) / (re + za);
  const double dta = (tinf - ta) * s_grad * (r_zlb_za * r_zlb_za);
  constexpr double zn1[5] = {0.0, 110.0, 100.0, 90.0, 72.5};
  const double z1 = za, z2 = 72.5;
  const double zgdif = (z2 - z1) * (re + z1) / (re + z2);
  double xs[5], ys[5], y2[5], u_sp[5];
  xs[0] = 0.0;
  ys[0] = 1.0 / ta;
  for (int k_sp = 1; k_sp < 4; ++k_sp) {
    xs[k_sp] = ((zn1[k_sp] - z1) * (re + z1) / (re + zn1[k_sp])) / zgdif;
    ys[k_sp] = ts.inv_tn1[k_sp];
  }
  xs[4] = 1.0;
  ys[4] = ts.inv_tn1[4];
  const double yd1 = -dta * (ys[0] * ys[0]) * zgdif;
  const double r_z2_z1 = (re + z2) / (re + z1);
  const double yd2 = -ts.tgn1_1 * (ys[4] * ys[4]) * zgdif * (r_z2_z1 * r_z2_z1);
  y2[0] = -0.5;
  u_sp[0] = (3.0 / xs[1]) * ((ys[1] - ys[0]) / xs[1] - yd1);
  for (int i = 1; i < 4; ++i) {
    const double sig = (xs[i] - xs[i - 1]) / (xs[i + 1] - xs[i - 1]);
    const double p_sp = sig * y2[i - 1] + 2.0;
    y2[i] = (sig - 1.0) / p_sp;
    u_sp[i] = (6.0 * ((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]) - (ys[i] - ys[i - 1]) / (xs[i] - xs[i - 1])) /
                   (xs[i + 1] - xs[i - 1]) -
               sig * u_sp[i - 1]) /
              p_sp;
  }
  const double dx34 = xs[4] - xs[3];
  const double un = (3.0 / dx34) * (yd2 - (ys[4] - ys[3]) / dx34);
  y2[4] = (un - 0.5 * u_sp[3]) / (0.5 * y2[3] + 1.0);
  for (int k_sp = 3; k_sp >= 0; --k_sp) y2[k_sp] = y2[k_sp] * y2[k_sp + 1] + u_sp[k_sp];

  auto splini_5 = [&](double x_val) -> double {
    double yi = 0.0;
    int klo = 0, khi = 1;
    while (x_val > xs[klo] && khi < 5) {
      double xx = x_val;
      if (khi < 4 && x_val >= xs[khi]) xx = xs[khi];
      const double hh = xs[khi] - xs[klo];
      const double aa = (xs[khi] - xx) / hh;
      const double bb = (xx - xs[klo]) / hh;
      const double a2 = aa * aa, b2 = bb * bb;
      yi += ((1.0 - a2) * ys[klo] * 0.5 + b2 * ys[khi] * 0.5 +
             ((-(1.0 + a2 * a2) * 0.25 + a2 * 0.5) * y2[klo] + (b2 * b2 * 0.25 - b2 * 0.5) * y2[khi]) * hh * hh *
                 (1.0 / 6.0)) *
            hh;
      ++klo;
      ++khi;
    }
    return yi;
  };

  const double zhf = ts.pdl1_24 * (1.0 + ts.pdl0_24 * c * tc.cd14_0);
  const double zh28 = ts.pdm22 * zhf;
  const double zh14 = ts.zh14;
  const double xmm = ts.xmm;
  const double slope_za = gamma_1 * (fm::log(tlb / ta) - s_grad * zg2_za);
  const double inv_z1_re = 1.0 + z1 / re;
  const double glb_za = gsurf / (inv_z1_re * inv_z1_re);
  const double gamm_1 = glb_za * zgdif * (1.0 / 831.4);
  const double s28 = splini_5(((zh28 - z1) * (re + z1) / (re + zh28)) / zgdif);
  const double s14 = splini_5(((zh14 - z1) * (re + z1) / (re + zh14)) / zgdif);
  const double log_dm14_d7 = (14.0 - xmm) * (slope_za - slope_xm - gamm_1 * s14);
  const double a_net = ts.zhm28 / (xmm - 14.0);
  const double ylog = a_net * log_dm14_d7;
  double dL7 = 0.0;
  if (ylog > 10.0) {
    dL7 = log_dm14_d7;
  } else if (ylog >= -10.0) {
    dL7 = fm::log(1.0 + fm::exp(ylog)) * ((xmm - 14.0) / ts.zhm28);
  }
  const double rl = ts.log_dlb28_14_mix + (g3 - g9) + (28.0 - xmm) * (slope_za - gamm_1 * s28) -
                    (14.0 - xmm) * (slope_za - gamm_1 * s14);
  dL7 += fast_ccor_log(h, rl, ts.hc14, ts.zc14) + fast_ccor_log(h, ts.rc14, ts.hcc14, ts.zcc14);
  return dL7;
}

inline double msis_density_hi_trig(const ThermoTimeCache& tc, double c, double s,
                                   double slong, double clong, double stloc, double ctloc, double h) {
  const ThermoStatic& ts = thermo_static();
  const double c2 = c * c, c4 = c2 * c2, s2 = s * s;
  const double c2lat = s2 - c2;
  const double gsurf = 980.616 * (1.0 - 0.0026373 * c2lat);
  const double re = 2.0 * gsurf / (3.085462E-6 + 2.27E-9 * c2lat) * 1.0E-5;

  const double plg0_1 = c;
  const double plg0_2 = 0.5 * (3.0 * c2 - 1.0);
  const double plg0_3 = 0.5 * (5.0 * c * c2 - 3.0 * c);
  const double plg0_4 = (35.0 * c4 - 30.0 * c2 + 3.0) * 0.125;
  const double plg0_5 = (63.0 * c4 * c - 70.0 * c2 * c + 15.0 * c) * 0.125;
  const double plg0_6 = (11.0 * c * plg0_5 - 5.0 * plg0_4) * (1.0 / 6.0);

  const double plg1_1 = s;
  const double plg1_2 = 3.0 * c * s;
  const double plg1_3 = 1.5 * (5.0 * c2 - 1.0) * s;
  const double plg1_4 = 2.5 * (7.0 * c2 * c - 3.0 * c) * s;
  const double plg1_5 = 1.875 * (21.0 * c4 - 14.0 * c2 + 1.0) * s;
  const double plg1_6 = (11.0 * c * plg1_5 - 6.0 * plg1_4) * 0.2;

  const double plg2_2 = 3.0 * s2;
  const double plg2_3 = 15.0 * s2 * c;
  const double plg2_4 = 7.5 * (7.0 * c2 - 1.0) * s2;
  const double plg2_5 = 3.0 * c * plg2_4 - 2.0 * plg2_3;
  const double plg2_6 = (11.0 * c * plg2_5 - 7.0 * plg2_4) * 0.25;
  const double plg2_7 = (13.0 * c * plg2_6 - 8.0 * plg2_5) * 0.2;

  const double plg3_3 = 15.0 * s2 * s;
  const double plg3_4 = 105.0 * s2 * s * c;
  const double plg3_5 = (9.0 * c * plg3_4 - 7.0 * plg3_3) * 0.5;
  const double plg3_6 = (11.0 * c * plg3_5 - 8.0 * plg3_4) * (1.0 / 3.0);

  const double s2tloc = 2.0 * stloc * ctloc;
  const double c2tloc = ctloc * ctloc - stloc * stloc;
  const double s3tloc = s2tloc * ctloc + c2tloc * stloc;
  const double c3tloc = c2tloc * ctloc - s2tloc * stloc;

  const double c2long = clong * clong - slong * slong;
  const double s2long = 2.0 * slong * clong;
  const double cmixed = tc.csec * c2long - tc.ssec * s2long;
  const double smixed = tc.ssec * c2long + tc.csec * s2long;

  double basis[58];
  basis[0] = plg0_1;
  basis[1] = plg0_2;
  basis[2] = plg0_3;
  basis[3] = plg0_4;
  basis[4] = plg0_5;
  basis[5] = plg0_6;
  basis[6] = c * plg0_1;
  basis[7] = c * plg0_3;
  basis[8] = c * plg0_5;
  basis[9] = c2 * plg0_1;
  basis[10] = c2 * plg0_3;
  basis[11] = c2 * plg0_5;

  basis[12] = plg1_1 * ctloc;
  basis[13] = plg1_2 * ctloc;
  basis[14] = plg1_3 * ctloc;
  basis[15] = plg1_5 * ctloc;
  basis[16] = plg1_1 * stloc;
  basis[17] = plg1_2 * stloc;
  basis[18] = plg1_3 * stloc;
  basis[19] = plg1_5 * stloc;

  basis[20] = plg2_2 * c2tloc;
  basis[21] = plg2_3 * c2tloc;
  basis[22] = plg2_4 * c2tloc;
  basis[23] = plg2_5 * c2tloc;
  basis[24] = plg2_2 * s2tloc;
  basis[25] = plg2_3 * s2tloc;
  basis[26] = plg2_4 * s2tloc;
  basis[27] = plg2_5 * s2tloc;

  basis[28] = plg3_3 * s3tloc;
  basis[29] = plg3_4 * s3tloc;
  basis[30] = plg3_6 * s3tloc;
  basis[31] = plg3_3 * c3tloc;
  basis[32] = plg3_4 * c3tloc;
  basis[33] = plg3_6 * c3tloc;

  const double c_p12 = c * plg1_2, c_p14 = c * plg1_4, c_p16 = c * plg1_6;
  basis[34] = plg1_1 * clong;
  basis[35] = plg1_2 * clong;
  basis[36] = plg1_3 * clong;
  basis[37] = plg1_4 * clong;
  basis[38] = plg1_5 * clong;
  basis[39] = plg1_6 * clong;
  basis[40] = c_p12 * clong;
  basis[41] = c_p14 * clong;
  basis[42] = c_p16 * clong;

  basis[43] = plg1_1 * slong;
  basis[44] = plg1_2 * slong;
  basis[45] = plg1_3 * slong;
  basis[46] = plg1_4 * slong;
  basis[47] = plg1_5 * slong;
  basis[48] = plg1_6 * slong;
  basis[49] = c_p12 * slong;
  basis[50] = c_p14 * slong;
  basis[51] = c_p16 * slong;

  basis[52] = plg2_3 * cmixed;
  basis[53] = plg2_5 * cmixed;
  basis[54] = plg2_7 * cmixed;
  basis[55] = plg2_3 * smixed;
  basis[56] = plg2_5 * smixed;
  basis[57] = plg2_7 * smixed;

  alignas(16) double gd[4];
  alignas(16) float gf[8];
#ifdef __wasm_simd128__
  v128_t ad0 = wasm_v128_load(tc.wd_const + 0);
  v128_t ad1 = wasm_v128_load(tc.wd_const + 2);
  v128_t af0 = wasm_v128_load(tc.wf_const + 0);
  v128_t af1 = wasm_v128_load(tc.wf_const + 4);
  v128_t ad2 = wasm_f64x2_splat(0.0);
  v128_t ad3 = wasm_f64x2_splat(0.0);
  v128_t af2 = wasm_f32x4_splat(0.0f);
  v128_t af3 = wasm_f32x4_splat(0.0f);
  for (int m = 0; m < 58; m += 2) {
    const double b0 = basis[m], b1 = basis[m + 1];
    const v128_t vbd0 = wasm_f64x2_splat(b0);
    const v128_t vbd1 = wasm_f64x2_splat(b1);
    const v128_t vbf0 = wasm_f32x4_splat(static_cast<float>(b0));
    const v128_t vbf1 = wasm_f32x4_splat(static_cast<float>(b1));
    ad0 = wasm_f64x2_add(ad0, wasm_f64x2_mul(vbd0, wasm_v128_load(tc.Wd[m] + 0)));
    ad1 = wasm_f64x2_add(ad1, wasm_f64x2_mul(vbd0, wasm_v128_load(tc.Wd[m] + 2)));
    af0 = wasm_f32x4_add(af0, wasm_f32x4_mul(vbf0, wasm_v128_load(tc.Wf[m] + 0)));
    af1 = wasm_f32x4_add(af1, wasm_f32x4_mul(vbf0, wasm_v128_load(tc.Wf[m] + 4)));
    ad2 = wasm_f64x2_add(ad2, wasm_f64x2_mul(vbd1, wasm_v128_load(tc.Wd[m + 1] + 0)));
    ad3 = wasm_f64x2_add(ad3, wasm_f64x2_mul(vbd1, wasm_v128_load(tc.Wd[m + 1] + 2)));
    af2 = wasm_f32x4_add(af2, wasm_f32x4_mul(vbf1, wasm_v128_load(tc.Wf[m + 1] + 0)));
    af3 = wasm_f32x4_add(af3, wasm_f32x4_mul(vbf1, wasm_v128_load(tc.Wf[m + 1] + 4)));
  }
  wasm_v128_store(gd + 0, wasm_f64x2_add(ad0, ad2));
  wasm_v128_store(gd + 2, wasm_f64x2_add(ad1, ad3));
  wasm_v128_store(gf + 0, wasm_f32x4_add(af0, af2));
  wasm_v128_store(gf + 4, wasm_f32x4_add(af1, af3));
#else
  for (int k = 0; k < 4; ++k) gd[k] = tc.wd_const[k];
  for (int k = 0; k < 7; ++k) gf[k] = tc.wf_const[k];
  for (int m = 0; m < 58; ++m) {
    const double bm = basis[m];
    const float bmf = static_cast<float>(bm);
    for (int k = 0; k < 4; ++k) gd[k] += bm * tc.Wd[m][k];
    for (int k = 0; k < 7; ++k) gf[k] += bmf * tc.Wf[m][k];
  }
#endif
  double g_out[11];
  for (int k = 0; k < 4; ++k) g_out[k] = gd[k];
  for (int k = 0; k < 7; ++k) g_out[k + 4] = gf[k];

  const double tinf = ts.base_pt * (1.0 + g_out[0]);
  const double g0 = ts.base_ps * (1.0 + g_out[1]);
  const double tlb = ts.base_tlb * (1.0 + g_out[2]);
  const double s_grad = g0 / (tinf - tlb);
  const double zlb = ts.zlb;
  const double zg2 = (h - zlb) * (re + zlb) / (re + h);
  const double inv_zlb_re = 1.0 + zlb / re;
  const double glb = gsurf / (inv_zlb_re * inv_zlb_re);
  const double tho = ts.tho;
  const double gamma_ao_szg2 = (16.0 * glb / (831.4 * tho)) * zg2;
  const double inv_zmho_re = 1.0 + ts.zmho / re;
  const double g_zmho = gsurf / (inv_zmho_re * inv_zmho_re);
  const double zsho = 831.4 * tho / (g_zmho * 16.0);
#ifdef __wasm_simd128__
  const v128_t ve_init = fm::exp2_f64x2(wasm_f64x2_make(-s_grad * zg2, -(h - ts.zmho) / ts.zsht));
  const double exp_szg2 = wasm_f64x2_extract_lane(ve_init, 0);
  const double exp_zmho = wasm_f64x2_extract_lane(ve_init, 1);
#else
  const double exp_szg2 = fm::exp(-s_grad * zg2);
  const double exp_zmho = fm::exp(-(h - ts.zmho) / ts.zsht);
#endif
  const double tt = tinf - (tinf - tlb) * exp_szg2;
  const double gamma_1 = glb / (s_grad * 831.4 * tinf);
  const double log_tr = fm::log(tlb / tt);
  const double slope_xm = gamma_1 * (log_tr - s_grad * zg2);

  double L7 = g_out[9] + log_tr + 14.0 * slope_xm;
  if (h <= 450.0) {
    L7 += msis_d7_lo_delta_log(ts, tc, h, c, re, gsurf, tinf, tlb, s_grad, gamma_1, slope_xm, g_out[3], g_out[9]);
  }
  const double L8 = g_out[10] - gamma_ao_szg2 - (ts.zsht / zsho) * (exp_zmho - 1.0);
#ifdef __wasm_simd128__
  const v128_t ve20 = fm::exp2_f64x2(wasm_f64x2_make(g_out[3] + log_tr + 28.0 * slope_xm,
                                                     g_out[4] + 0.62 * log_tr + 4.0 * slope_xm));
  const v128_t ve16 = fm::exp2_f64x2(wasm_f64x2_make(g_out[5] + log_tr + 16.0 * slope_xm,
                                                     g_out[8] + 0.62 * log_tr + slope_xm));
  const v128_t ve78 = fm::exp2_f64x2(wasm_f64x2_make(L7, L8));
  const double d2 = ts.dlb0[0] * wasm_f64x2_extract_lane(ve20, 0);
  const double d0 = ts.dlb0[1] * wasm_f64x2_extract_lane(ve20, 1);
  const double d1 = ts.dlb0[2] * wasm_f64x2_extract_lane(ve16, 0);
  const double d6 = ts.dlb0[5] * wasm_f64x2_extract_lane(ve16, 1);
  const double d7 = ts.dlb0[6] * wasm_f64x2_extract_lane(ve78, 0);
  const double d8 = ts.dlb0[7] * wasm_f64x2_extract_lane(ve78, 1);
#else
  const double d2 = ts.dlb0[0] * fm::exp(g_out[3] + log_tr + 28.0 * slope_xm);
  const double d0 = ts.dlb0[1] * fm::exp(g_out[4] + 0.62 * log_tr + 4.0 * slope_xm);
  const double d1 = ts.dlb0[2] * fm::exp(g_out[5] + log_tr + 16.0 * slope_xm);
  const double d6 = ts.dlb0[5] * fm::exp(g_out[8] + 0.62 * log_tr + slope_xm);
  const double d7 = ts.dlb0[6] * fm::exp(L7);
  const double d8 = ts.dlb0[7] * fm::exp(L8);
#endif
  double d3 = 0.0, d4 = 0.0;
  if (16.0 * slope_xm > -42.0) {
    const double rc32 = ts.rc32_0 * (1.0 + ts.rc32_dfa * tc.dfa);
    const double L3 = g_out[6] + log_tr + 32.0 * slope_xm + fast_ccor2_log(h, rc32, ts.hcc32, ts.zcc32, ts.hcc232);
    if (24.0 * slope_xm > -42.0) {
#ifdef __wasm_simd128__
      const v128_t ve34 = fm::exp2_f64x2(wasm_f64x2_make(L3, g_out[7] + 1.17 * log_tr + 40.0 * slope_xm));
      d3 = ts.dlb0[3] * wasm_f64x2_extract_lane(ve34, 0);
      d4 = ts.dlb0[4] * wasm_f64x2_extract_lane(ve34, 1);
#else
      d3 = ts.dlb0[3] * fm::exp(L3);
      d4 = ts.dlb0[4] * fm::exp(g_out[7] + 1.17 * log_tr + 40.0 * slope_xm);
#endif
    } else {
      d3 = ts.dlb0[3] * fm::exp(L3);
    }
  } else if (24.0 * slope_xm > -42.0) {
    d4 = ts.dlb0[4] * fm::exp(g_out[7] + 1.17 * log_tr + 40.0 * slope_xm);
  }

  return 1.66E-21 * (4.0 * d0 + 16.0 * d1 + 28.0 * d2 + 32.0 * d3 + 40.0 * d4 + d6 + 14.0 * d7 + 16.0 * d8);
}

inline void msis_density_hi_trig2(const ThermoTimeCache& tc, const double c_in[2], const double s_in[2],
                                  const double slong_in[2], const double clong_in[2], const double stloc_in[2],
                                  const double ctloc_in[2], const double h_in[2], double rho_out[2]) {
#ifdef __wasm_simd128__
  const ThermoStatic& ts = thermo_static();
  const v128_t vc = wasm_v128_load(c_in);
  const v128_t vs = wasm_v128_load(s_in);
  const v128_t vslong = wasm_v128_load(slong_in);
  const v128_t vclong = wasm_v128_load(clong_in);
  const v128_t vstloc = wasm_v128_load(stloc_in);
  const v128_t vctloc = wasm_v128_load(ctloc_in);
  const v128_t vh = wasm_v128_load(h_in);

  const v128_t v_one = wasm_f64x2_splat(1.0);
  const v128_t v_two = wasm_f64x2_splat(2.0);
  const v128_t v_three = wasm_f64x2_splat(3.0);
  const v128_t v_five = wasm_f64x2_splat(5.0);
  const v128_t v_seven = wasm_f64x2_splat(7.0);
  const v128_t v_eleven = wasm_f64x2_splat(11.0);
  const v128_t v_half = wasm_f64x2_splat(0.5);
  const v128_t v_eighth = wasm_f64x2_splat(0.125);

  const v128_t vc2 = wasm_f64x2_mul(vc, vc), vc4 = wasm_f64x2_mul(vc2, vc2), vs2 = wasm_f64x2_mul(vs, vs);
  const v128_t vc2lat = wasm_f64x2_sub(vs2, vc2);
  const v128_t vgsurf = wasm_f64x2_mul(wasm_f64x2_splat(980.616),
                                       wasm_f64x2_sub(v_one, wasm_f64x2_mul(wasm_f64x2_splat(0.0026373), vc2lat)));
  const v128_t vre = wasm_f64x2_mul(
      wasm_f64x2_div(wasm_f64x2_mul(v_two, vgsurf),
                     wasm_f64x2_add(wasm_f64x2_splat(3.085462E-6), wasm_f64x2_mul(wasm_f64x2_splat(2.27E-9), vc2lat))),
      wasm_f64x2_splat(1.0E-5));

  const v128_t vc3 = wasm_f64x2_mul(vc, vc2);
  const v128_t plg0_1 = vc;
  const v128_t plg0_2 = wasm_f64x2_mul(v_half, wasm_f64x2_sub(wasm_f64x2_mul(v_three, vc2), v_one));
  const v128_t plg0_3 = wasm_f64x2_mul(v_half, wasm_f64x2_sub(wasm_f64x2_mul(v_five, vc3), wasm_f64x2_mul(v_three, vc)));
  const v128_t plg0_4 = wasm_f64x2_mul(
      wasm_f64x2_add(wasm_f64x2_sub(wasm_f64x2_mul(wasm_f64x2_splat(35.0), vc4), wasm_f64x2_mul(wasm_f64x2_splat(30.0), vc2)),
                     v_three),
      v_eighth);
  const v128_t plg0_5 = wasm_f64x2_mul(
      wasm_f64x2_add(wasm_f64x2_sub(wasm_f64x2_mul(wasm_f64x2_splat(63.0), wasm_f64x2_mul(vc4, vc)),
                                    wasm_f64x2_mul(wasm_f64x2_splat(70.0), vc3)),
                     wasm_f64x2_mul(wasm_f64x2_splat(15.0), vc)),
      v_eighth);
  const v128_t plg0_6 = wasm_f64x2_mul(
      wasm_f64x2_sub(wasm_f64x2_mul(v_eleven, wasm_f64x2_mul(vc, plg0_5)), wasm_f64x2_mul(v_five, plg0_4)),
      wasm_f64x2_splat(1.0 / 6.0));

  const v128_t plg1_1 = vs;
  const v128_t plg1_2 = wasm_f64x2_mul(v_three, wasm_f64x2_mul(vc, vs));
  const v128_t plg1_3 = wasm_f64x2_mul(wasm_f64x2_splat(1.5),
                                       wasm_f64x2_mul(wasm_f64x2_sub(wasm_f64x2_mul(v_five, vc2), v_one), vs));
  const v128_t plg1_4 = wasm_f64x2_mul(
      wasm_f64x2_splat(2.5),
      wasm_f64x2_mul(wasm_f64x2_sub(wasm_f64x2_mul(v_seven, vc3), wasm_f64x2_mul(v_three, vc)), vs));
  const v128_t plg1_5 = wasm_f64x2_mul(
      wasm_f64x2_splat(1.875),
      wasm_f64x2_mul(wasm_f64x2_add(wasm_f64x2_sub(wasm_f64x2_mul(wasm_f64x2_splat(21.0), vc4),
                                                   wasm_f64x2_mul(wasm_f64x2_splat(14.0), vc2)),
                                    v_one),
                     vs));
  const v128_t plg1_6 = wasm_f64x2_mul(
      wasm_f64x2_sub(wasm_f64x2_mul(v_eleven, wasm_f64x2_mul(vc, plg1_5)), wasm_f64x2_mul(wasm_f64x2_splat(6.0), plg1_4)),
      wasm_f64x2_splat(0.2));

  const v128_t plg2_2 = wasm_f64x2_mul(v_three, vs2);
  const v128_t plg2_3 = wasm_f64x2_mul(wasm_f64x2_splat(15.0), wasm_f64x2_mul(vs2, vc));
  const v128_t plg2_4 = wasm_f64x2_mul(wasm_f64x2_splat(7.5),
                                       wasm_f64x2_mul(wasm_f64x2_sub(wasm_f64x2_mul(v_seven, vc2), v_one), vs2));
  const v128_t plg2_5 = wasm_f64x2_sub(wasm_f64x2_mul(v_three, wasm_f64x2_mul(vc, plg2_4)),
                                       wasm_f64x2_mul(v_two, plg2_3));
  const v128_t plg2_6 = wasm_f64x2_mul(
      wasm_f64x2_sub(wasm_f64x2_mul(v_eleven, wasm_f64x2_mul(vc, plg2_5)), wasm_f64x2_mul(v_seven, plg2_4)),
      wasm_f64x2_splat(0.25));
  const v128_t plg2_7 = wasm_f64x2_mul(
      wasm_f64x2_sub(wasm_f64x2_mul(wasm_f64x2_splat(13.0), wasm_f64x2_mul(vc, plg2_6)),
                     wasm_f64x2_mul(wasm_f64x2_splat(8.0), plg2_5)),
      wasm_f64x2_splat(0.2));

  const v128_t vs3 = wasm_f64x2_mul(vs2, vs);
  const v128_t plg3_3 = wasm_f64x2_mul(wasm_f64x2_splat(15.0), vs3);
  const v128_t plg3_4 = wasm_f64x2_mul(wasm_f64x2_splat(105.0), wasm_f64x2_mul(vs3, vc));
  const v128_t plg3_5 = wasm_f64x2_mul(
      wasm_f64x2_sub(wasm_f64x2_mul(wasm_f64x2_splat(9.0), wasm_f64x2_mul(vc, plg3_4)), wasm_f64x2_mul(v_seven, plg3_3)),
      v_half);
  const v128_t plg3_6 = wasm_f64x2_mul(
      wasm_f64x2_sub(wasm_f64x2_mul(v_eleven, wasm_f64x2_mul(vc, plg3_5)),
                     wasm_f64x2_mul(wasm_f64x2_splat(8.0), plg3_4)),
      wasm_f64x2_splat(1.0 / 3.0));

  const v128_t s2tloc = wasm_f64x2_mul(v_two, wasm_f64x2_mul(vstloc, vctloc));
  const v128_t c2tloc = wasm_f64x2_sub(wasm_f64x2_mul(vctloc, vctloc), wasm_f64x2_mul(vstloc, vstloc));
  const v128_t s3tloc = wasm_f64x2_add(wasm_f64x2_mul(s2tloc, vctloc), wasm_f64x2_mul(c2tloc, vstloc));
  const v128_t c3tloc = wasm_f64x2_sub(wasm_f64x2_mul(c2tloc, vctloc), wasm_f64x2_mul(s2tloc, vstloc));

  const v128_t c2long = wasm_f64x2_sub(wasm_f64x2_mul(vclong, vclong), wasm_f64x2_mul(vslong, vslong));
  const v128_t s2long = wasm_f64x2_mul(v_two, wasm_f64x2_mul(vslong, vclong));
  const v128_t vcsec = wasm_f64x2_splat(tc.csec), vssec = wasm_f64x2_splat(tc.ssec);
  const v128_t cmixed = wasm_f64x2_sub(wasm_f64x2_mul(vcsec, c2long), wasm_f64x2_mul(vssec, s2long));
  const v128_t smixed = wasm_f64x2_add(wasm_f64x2_mul(vssec, c2long), wasm_f64x2_mul(vcsec, s2long));

  v128_t basis[58];
  basis[0] = plg0_1;
  basis[1] = plg0_2;
  basis[2] = plg0_3;
  basis[3] = plg0_4;
  basis[4] = plg0_5;
  basis[5] = plg0_6;
  basis[6] = vc2;
  basis[7] = wasm_f64x2_mul(vc, plg0_3);
  basis[8] = wasm_f64x2_mul(vc, plg0_5);
  basis[9] = vc3;
  basis[10] = wasm_f64x2_mul(vc2, plg0_3);
  basis[11] = wasm_f64x2_mul(vc2, plg0_5);

  basis[12] = wasm_f64x2_mul(plg1_1, vctloc);
  basis[13] = wasm_f64x2_mul(plg1_2, vctloc);
  basis[14] = wasm_f64x2_mul(plg1_3, vctloc);
  basis[15] = wasm_f64x2_mul(plg1_5, vctloc);
  basis[16] = wasm_f64x2_mul(plg1_1, vstloc);
  basis[17] = wasm_f64x2_mul(plg1_2, vstloc);
  basis[18] = wasm_f64x2_mul(plg1_3, vstloc);
  basis[19] = wasm_f64x2_mul(plg1_5, vstloc);

  basis[20] = wasm_f64x2_mul(plg2_2, c2tloc);
  basis[21] = wasm_f64x2_mul(plg2_3, c2tloc);
  basis[22] = wasm_f64x2_mul(plg2_4, c2tloc);
  basis[23] = wasm_f64x2_mul(plg2_5, c2tloc);
  basis[24] = wasm_f64x2_mul(plg2_2, s2tloc);
  basis[25] = wasm_f64x2_mul(plg2_3, s2tloc);
  basis[26] = wasm_f64x2_mul(plg2_4, s2tloc);
  basis[27] = wasm_f64x2_mul(plg2_5, s2tloc);

  basis[28] = wasm_f64x2_mul(plg3_3, s3tloc);
  basis[29] = wasm_f64x2_mul(plg3_4, s3tloc);
  basis[30] = wasm_f64x2_mul(plg3_6, s3tloc);
  basis[31] = wasm_f64x2_mul(plg3_3, c3tloc);
  basis[32] = wasm_f64x2_mul(plg3_4, c3tloc);
  basis[33] = wasm_f64x2_mul(plg3_6, c3tloc);

  const v128_t c_p12 = wasm_f64x2_mul(vc, plg1_2);
  const v128_t c_p14 = wasm_f64x2_mul(vc, plg1_4);
  const v128_t c_p16 = wasm_f64x2_mul(vc, plg1_6);
  basis[34] = wasm_f64x2_mul(plg1_1, vclong);
  basis[35] = wasm_f64x2_mul(plg1_2, vclong);
  basis[36] = wasm_f64x2_mul(plg1_3, vclong);
  basis[37] = wasm_f64x2_mul(plg1_4, vclong);
  basis[38] = wasm_f64x2_mul(plg1_5, vclong);
  basis[39] = wasm_f64x2_mul(plg1_6, vclong);
  basis[40] = wasm_f64x2_mul(c_p12, vclong);
  basis[41] = wasm_f64x2_mul(c_p14, vclong);
  basis[42] = wasm_f64x2_mul(c_p16, vclong);

  basis[43] = wasm_f64x2_mul(plg1_1, vslong);
  basis[44] = wasm_f64x2_mul(plg1_2, vslong);
  basis[45] = wasm_f64x2_mul(plg1_3, vslong);
  basis[46] = wasm_f64x2_mul(plg1_4, vslong);
  basis[47] = wasm_f64x2_mul(plg1_5, vslong);
  basis[48] = wasm_f64x2_mul(plg1_6, vslong);
  basis[49] = wasm_f64x2_mul(c_p12, vslong);
  basis[50] = wasm_f64x2_mul(c_p14, vslong);
  basis[51] = wasm_f64x2_mul(c_p16, vslong);

  basis[52] = wasm_f64x2_mul(plg2_3, cmixed);
  basis[53] = wasm_f64x2_mul(plg2_5, cmixed);
  basis[54] = wasm_f64x2_mul(plg2_7, cmixed);
  basis[55] = wasm_f64x2_mul(plg2_3, smixed);
  basis[56] = wasm_f64x2_mul(plg2_5, smixed);
  basis[57] = wasm_f64x2_mul(plg2_7, smixed);

  v128_t ad0_0 = wasm_v128_load(tc.wd_const + 0);
  v128_t ad0_1 = wasm_v128_load(tc.wd_const + 2);
  v128_t ad1_0 = ad0_0;
  v128_t ad1_1 = ad0_1;
  v128_t af0_0 = wasm_v128_load(tc.wf_const + 0);
  v128_t af0_1 = wasm_v128_load(tc.wf_const + 4);
  v128_t af1_0 = af0_0;
  v128_t af1_1 = af0_1;
  for (int m = 0; m < 58; ++m) {
    const v128_t vb = basis[m];
    const v128_t vbd0 = wasm_i64x2_shuffle(vb, vb, 0, 0);
    const v128_t vbd1 = wasm_i64x2_shuffle(vb, vb, 1, 1);
    const v128_t vbf = wasm_f32x4_demote_f64x2_zero(vb);
    const v128_t vbf0 = wasm_i32x4_shuffle(vbf, vbf, 0, 0, 0, 0);
    const v128_t vbf1 = wasm_i32x4_shuffle(vbf, vbf, 1, 1, 1, 1);
    const v128_t wd0 = wasm_v128_load(tc.Wd[m] + 0);
    const v128_t wd1 = wasm_v128_load(tc.Wd[m] + 2);
    const v128_t wf0 = wasm_v128_load(tc.Wf[m] + 0);
    const v128_t wf1 = wasm_v128_load(tc.Wf[m] + 4);
    ad0_0 = wasm_f64x2_add(ad0_0, wasm_f64x2_mul(vbd0, wd0));
    ad0_1 = wasm_f64x2_add(ad0_1, wasm_f64x2_mul(vbd0, wd1));
    ad1_0 = wasm_f64x2_add(ad1_0, wasm_f64x2_mul(vbd1, wd0));
    ad1_1 = wasm_f64x2_add(ad1_1, wasm_f64x2_mul(vbd1, wd1));
    af0_0 = wasm_f32x4_add(af0_0, wasm_f32x4_mul(vbf0, wf0));
    af0_1 = wasm_f32x4_add(af0_1, wasm_f32x4_mul(vbf0, wf1));
    af1_0 = wasm_f32x4_add(af1_0, wasm_f32x4_mul(vbf1, wf0));
    af1_1 = wasm_f32x4_add(af1_1, wasm_f32x4_mul(vbf1, wf1));
  }
  const v128_t vg0 = wasm_i64x2_shuffle(ad0_0, ad1_0, 0, 2);
  const v128_t vg1 = wasm_i64x2_shuffle(ad0_0, ad1_0, 1, 3);
  const v128_t vg2 = wasm_i64x2_shuffle(ad0_1, ad1_1, 0, 2);
  const v128_t vg3 = wasm_i64x2_shuffle(ad0_1, ad1_1, 1, 3);
  const v128_t f45 = wasm_i32x4_shuffle(af0_0, af1_0, 0, 4, 1, 5);
  const v128_t f67 = wasm_i32x4_shuffle(af0_0, af1_0, 2, 6, 3, 7);
  const v128_t f89 = wasm_i32x4_shuffle(af0_1, af1_1, 0, 4, 1, 5);
  const v128_t f10 = wasm_i32x4_shuffle(af0_1, af1_1, 2, 6, 2, 6);
  const v128_t vg4 = wasm_f64x2_promote_low_f32x4(f45);
  const v128_t vg5 = wasm_f64x2_promote_low_f32x4(wasm_i64x2_shuffle(f45, f45, 1, 1));
  const v128_t vg6 = wasm_f64x2_promote_low_f32x4(f67);
  const v128_t vg7 = wasm_f64x2_promote_low_f32x4(wasm_i64x2_shuffle(f67, f67, 1, 1));
  const v128_t vg8 = wasm_f64x2_promote_low_f32x4(f89);
  const v128_t vg9 = wasm_f64x2_promote_low_f32x4(wasm_i64x2_shuffle(f89, f89, 1, 1));
  const v128_t vg10 = wasm_f64x2_promote_low_f32x4(f10);

  const v128_t vtinf = wasm_f64x2_mul(wasm_f64x2_splat(ts.base_pt), wasm_f64x2_add(v_one, vg0));
  const v128_t vg0_grav = wasm_f64x2_mul(wasm_f64x2_splat(ts.base_ps), wasm_f64x2_add(v_one, vg1));
  const v128_t vtlb = wasm_f64x2_mul(wasm_f64x2_splat(ts.base_tlb), wasm_f64x2_add(v_one, vg2));
  const v128_t vdt_inf = wasm_f64x2_sub(vtinf, vtlb);
  const v128_t vs_grad = wasm_f64x2_div(vg0_grav, vdt_inf);
  const v128_t vzlb = wasm_f64x2_splat(ts.zlb);
  const v128_t vzg2 = wasm_f64x2_div(wasm_f64x2_mul(wasm_f64x2_sub(vh, vzlb), wasm_f64x2_add(vre, vzlb)),
                                     wasm_f64x2_add(vre, vh));
  const v128_t vszg2 = wasm_f64x2_mul(vs_grad, vzg2);
  const v128_t vtt = wasm_f64x2_sub(vtinf, wasm_f64x2_mul(vdt_inf, fm::exp2_f64x2(wasm_f64x2_neg(vszg2))));
  const v128_t vinv_zlb_re = wasm_f64x2_add(v_one, wasm_f64x2_div(vzlb, vre));
  const v128_t vglb = wasm_f64x2_div(vgsurf, wasm_f64x2_mul(vinv_zlb_re, vinv_zlb_re));
  const v128_t vgamma_1 = wasm_f64x2_div(vglb, wasm_f64x2_mul(vs_grad, wasm_f64x2_mul(wasm_f64x2_splat(831.4), vtinf)));
  const v128_t vlog_tr = fm::log2_f64x2(wasm_f64x2_div(vtlb, vtt));
  const v128_t vslope_xm = wasm_f64x2_mul(vgamma_1, wasm_f64x2_sub(vlog_tr, vszg2));
  const v128_t vlog_tr_062 = wasm_f64x2_mul(wasm_f64x2_splat(0.62), vlog_tr);

  const v128_t vd2 = wasm_f64x2_mul(
      wasm_f64x2_splat(ts.dlb0[0]),
      fm::exp2_f64x2(wasm_f64x2_add(wasm_f64x2_add(vg3, vlog_tr), wasm_f64x2_mul(wasm_f64x2_splat(28.0), vslope_xm))));
  const v128_t vd0 = wasm_f64x2_mul(
      wasm_f64x2_splat(ts.dlb0[1]),
      fm::exp2_f64x2(wasm_f64x2_add(wasm_f64x2_add(vg4, vlog_tr_062), wasm_f64x2_mul(wasm_f64x2_splat(4.0), vslope_xm))));
  const v128_t vd1 = wasm_f64x2_mul(
      wasm_f64x2_splat(ts.dlb0[2]),
      fm::exp2_f64x2(wasm_f64x2_add(wasm_f64x2_add(vg5, vlog_tr), wasm_f64x2_mul(wasm_f64x2_splat(16.0), vslope_xm))));
  const v128_t vd6 = wasm_f64x2_mul(wasm_f64x2_splat(ts.dlb0[5]),
                                    fm::exp2_f64x2(wasm_f64x2_add(wasm_f64x2_add(vg8, vlog_tr_062), vslope_xm)));

  v128_t vd3 = wasm_f64x2_splat(0.0);
  const v128_t m3 = wasm_f64x2_gt(wasm_f64x2_mul(wasm_f64x2_splat(16.0), vslope_xm), wasm_f64x2_splat(-42.0));
  if (wasm_v128_any_true(m3)) {
    const double rc32 = ts.rc32_0 * (1.0 + ts.rc32_dfa * tc.dfa);
    const v128_t vcc32 = wasm_f64x2_make(fast_ccor2_log(h_in[0], rc32, ts.hcc32, ts.zcc32, ts.hcc232),
                                         fast_ccor2_log(h_in[1], rc32, ts.hcc32, ts.zcc32, ts.hcc232));
    const v128_t vL3 = wasm_f64x2_add(
        wasm_f64x2_add(vg6, vlog_tr),
        wasm_f64x2_add(wasm_f64x2_mul(wasm_f64x2_splat(32.0), vslope_xm), vcc32));
    vd3 = wasm_v128_and(m3, wasm_f64x2_mul(wasm_f64x2_splat(ts.dlb0[3]), fm::exp2_f64x2(vL3)));
  }

  v128_t vd4 = wasm_f64x2_splat(0.0);
  const v128_t m4 = wasm_f64x2_gt(wasm_f64x2_mul(wasm_f64x2_splat(24.0), vslope_xm), wasm_f64x2_splat(-42.0));
  if (wasm_v128_any_true(m4)) {
    const v128_t vL4 = wasm_f64x2_add(wasm_f64x2_add(vg7, wasm_f64x2_mul(wasm_f64x2_splat(1.17), vlog_tr)),
                                      wasm_f64x2_mul(wasm_f64x2_splat(40.0), vslope_xm));
    vd4 = wasm_v128_and(m4, wasm_f64x2_mul(wasm_f64x2_splat(ts.dlb0[4]), fm::exp2_f64x2(vL4)));
  }

  v128_t vL7 = wasm_f64x2_add(wasm_f64x2_add(vg9, vlog_tr), wasm_f64x2_mul(wasm_f64x2_splat(14.0), vslope_xm));
  if (h_in[0] <= 450.0 || h_in[1] <= 450.0) {
    const double dL7_0 =
        h_in[0] <= 450.0
            ? msis_d7_lo_delta_log(ts, tc, h_in[0], c_in[0], wasm_f64x2_extract_lane(vre, 0),
                                   wasm_f64x2_extract_lane(vgsurf, 0), wasm_f64x2_extract_lane(vtinf, 0),
                                   wasm_f64x2_extract_lane(vtlb, 0), wasm_f64x2_extract_lane(vs_grad, 0),
                                   wasm_f64x2_extract_lane(vgamma_1, 0), wasm_f64x2_extract_lane(vslope_xm, 0),
                                   wasm_f64x2_extract_lane(vg3, 0), wasm_f64x2_extract_lane(vg9, 0))
            : 0.0;
    const double dL7_1 =
        h_in[1] <= 450.0
            ? msis_d7_lo_delta_log(ts, tc, h_in[1], c_in[1], wasm_f64x2_extract_lane(vre, 1),
                                   wasm_f64x2_extract_lane(vgsurf, 1), wasm_f64x2_extract_lane(vtinf, 1),
                                   wasm_f64x2_extract_lane(vtlb, 1), wasm_f64x2_extract_lane(vs_grad, 1),
                                   wasm_f64x2_extract_lane(vgamma_1, 1), wasm_f64x2_extract_lane(vslope_xm, 1),
                                   wasm_f64x2_extract_lane(vg3, 1), wasm_f64x2_extract_lane(vg9, 1))
            : 0.0;
    vL7 = wasm_f64x2_add(vL7, wasm_f64x2_make(dL7_0, dL7_1));
  }
  const v128_t vd7 = wasm_f64x2_mul(wasm_f64x2_splat(ts.dlb0[6]), fm::exp2_f64x2(vL7));

  const double tho = ts.tho;
  const v128_t vgamma_ao = wasm_f64x2_mul(wasm_f64x2_mul(vglb, wasm_f64x2_splat(16.0 / (831.4 * tho))), vzg2);
  const v128_t vzmho = wasm_f64x2_splat(ts.zmho);
  const v128_t vinv_zmho_re = wasm_f64x2_add(v_one, wasm_f64x2_div(vzmho, vre));
  const v128_t vg_zmho = wasm_f64x2_div(vgsurf, wasm_f64x2_mul(vinv_zmho_re, vinv_zmho_re));
  const v128_t vzsho = wasm_f64x2_div(wasm_f64x2_splat(831.4 * tho / 16.0), vg_zmho);
  const v128_t vexp_zmho = fm::exp2_f64x2(wasm_f64x2_mul(wasm_f64x2_sub(vzmho, vh), wasm_f64x2_splat(1.0 / ts.zsht)));
  const v128_t vd8 = wasm_f64x2_mul(
      wasm_f64x2_splat(ts.dlb0[7]),
      fm::exp2_f64x2(wasm_f64x2_sub(wasm_f64x2_sub(vg10, vgamma_ao),
                                    wasm_f64x2_mul(wasm_f64x2_div(wasm_f64x2_splat(ts.zsht), vzsho),
                                                   wasm_f64x2_sub(vexp_zmho, v_one)))));

  const v128_t vsum = wasm_f64x2_add(
      wasm_f64x2_add(wasm_f64x2_add(wasm_f64x2_mul(wasm_f64x2_splat(4.0), vd0),
                                    wasm_f64x2_mul(wasm_f64x2_splat(16.0), vd1)),
                     wasm_f64x2_add(wasm_f64x2_mul(wasm_f64x2_splat(28.0), vd2),
                                    wasm_f64x2_mul(wasm_f64x2_splat(32.0), vd3))),
      wasm_f64x2_add(wasm_f64x2_add(wasm_f64x2_mul(wasm_f64x2_splat(40.0), vd4), vd6),
                     wasm_f64x2_add(wasm_f64x2_mul(wasm_f64x2_splat(14.0), vd7),
                                    wasm_f64x2_mul(wasm_f64x2_splat(16.0), vd8))));
  wasm_v128_store(rho_out, wasm_f64x2_mul(wasm_f64x2_splat(1.66E-21), vsum));
#else
  rho_out[0] = msis_density_hi_trig(tc, c_in[0], s_in[0], slong_in[0], clong_in[0], stloc_in[0], ctloc_in[0], h_in[0]);
  rho_out[1] = msis_density_hi_trig(tc, c_in[1], s_in[1], slong_in[1], clong_in[1], stloc_in[1], ctloc_in[1], h_in[1]);
#endif
}

[[gnu::noinline]] inline void msis_density_hi_trig4(
    const ThermoTimeCache& tc, const float* __restrict c_in, const float* __restrict s_in,
    const float* __restrict slong_in, const float* __restrict clong_in, const float* __restrict stloc_in,
    const float* __restrict ctloc_in, const double* __restrict h_in, int n_lanes, double* __restrict rho_out) {
#ifdef __wasm_simd128__
  const ThermoStatic& ts = g_thermo_static;
  c_in = static_cast<const float*>(__builtin_assume_aligned(c_in, 16));
  s_in = static_cast<const float*>(__builtin_assume_aligned(s_in, 16));
  slong_in = static_cast<const float*>(__builtin_assume_aligned(slong_in, 16));
  clong_in = static_cast<const float*>(__builtin_assume_aligned(clong_in, 16));
  stloc_in = static_cast<const float*>(__builtin_assume_aligned(stloc_in, 16));
  ctloc_in = static_cast<const float*>(__builtin_assume_aligned(ctloc_in, 16));
  h_in = static_cast<const double*>(__builtin_assume_aligned(h_in, 16));
  rho_out = static_cast<double*>(__builtin_assume_aligned(rho_out, 16));

  const v128_t vc = wasm_v128_load(c_in);
  const v128_t vs = wasm_v128_load(s_in);

  const v128_t v_one = wasm_f32x4_splat(1.0f);
  const v128_t v_two = wasm_f32x4_splat(2.0f);
  const v128_t v_three = wasm_f32x4_splat(3.0f);
  const v128_t v_five = wasm_f32x4_splat(5.0f);
  const v128_t v_seven = wasm_f32x4_splat(7.0f);
  const v128_t v_eleven = wasm_f32x4_splat(11.0f);
  const v128_t v_half = wasm_f32x4_splat(0.5f);
  const v128_t v_eighth = wasm_f32x4_splat(0.125f);

  const v128_t vc2 = wasm_f32x4_mul(vc, vc), vc4 = wasm_f32x4_mul(vc2, vc2);
  const v128_t vc3 = wasm_f32x4_mul(vc, vc2);

  #define MSIS_ACC(acc, m, k) acc = wasm_f32x4_add(acc, wasm_f32x4_mul(vb, wasm_v128_load32_splat(&tc.Wf12[m][k])))

  // Order 0 zonal terms (m = 0..11; m = 5 is identically zero in NRLMSISE-00)
  v128_t acc0  = wasm_f32x4_mul(vc, wasm_v128_load32_splat(&tc.Wf12[0][0]));
  v128_t acc1  = wasm_f32x4_mul(vc, wasm_v128_load32_splat(&tc.Wf12[0][1]));
  v128_t acc2  = wasm_f32x4_mul(vc, wasm_v128_load32_splat(&tc.Wf12[0][2]));
  v128_t acc3  = wasm_f32x4_mul(vc, wasm_v128_load32_splat(&tc.Wf12[0][3]));
  v128_t acc4  = wasm_f32x4_mul(vc, wasm_v128_load32_splat(&tc.Wf12[0][4]));
  v128_t acc5  = wasm_f32x4_mul(vc, wasm_v128_load32_splat(&tc.Wf12[0][5]));
  v128_t acc6  = wasm_f32x4_mul(vc, wasm_v128_load32_splat(&tc.Wf12[0][6]));
  v128_t acc7  = wasm_f32x4_mul(vc, wasm_v128_load32_splat(&tc.Wf12[0][7]));
  v128_t acc8  = wasm_f32x4_mul(vc, wasm_v128_load32_splat(&tc.Wf12[0][8]));
  v128_t acc9  = wasm_f32x4_mul(vc, wasm_v128_load32_splat(&tc.Wf12[0][9]));
  v128_t acc10 = wasm_f32x4_mul(vc, wasm_v128_load32_splat(&tc.Wf12[0][10]));
  {
    v128_t vb = wasm_f32x4_mul(v_half, wasm_f32x4_sub(wasm_f32x4_mul(v_three, vc2), v_one));  // m = 1
    MSIS_ACC(acc0, 1, 0); MSIS_ACC(acc1, 1, 1); MSIS_ACC(acc2, 1, 2); MSIS_ACC(acc4, 1, 4); MSIS_ACC(acc5, 1, 5);
    MSIS_ACC(acc6, 1, 6); MSIS_ACC(acc7, 1, 7); MSIS_ACC(acc8, 1, 8); MSIS_ACC(acc9, 1, 9); MSIS_ACC(acc10, 1, 10);

    const v128_t plg0_3 = wasm_f32x4_mul(v_half, wasm_f32x4_sub(wasm_f32x4_mul(v_five, vc3), wasm_f32x4_mul(v_three, vc)));
    vb = plg0_3;  // m = 2
    MSIS_ACC(acc0, 2, 0); MSIS_ACC(acc4, 2, 4); MSIS_ACC(acc5, 2, 5);
    MSIS_ACC(acc7, 2, 7); MSIS_ACC(acc8, 2, 8); MSIS_ACC(acc9, 2, 9);

    vb = wasm_f32x4_mul(
        wasm_f32x4_add(wasm_f32x4_sub(wasm_f32x4_mul(wasm_f32x4_splat(35.0f), vc4), wasm_f32x4_mul(wasm_f32x4_splat(30.0f), vc2)),
                       v_three),
        v_eighth);  // m = 3
    MSIS_ACC(acc0, 3, 0); MSIS_ACC(acc1, 3, 1); MSIS_ACC(acc4, 3, 4); MSIS_ACC(acc5, 3, 5);
    MSIS_ACC(acc7, 3, 7); MSIS_ACC(acc8, 3, 8); MSIS_ACC(acc9, 3, 9); MSIS_ACC(acc10, 3, 10);

    const v128_t plg0_5 = wasm_f32x4_mul(
        wasm_f32x4_add(wasm_f32x4_sub(wasm_f32x4_mul(wasm_f32x4_splat(63.0f), wasm_f32x4_mul(vc4, vc)),
                                      wasm_f32x4_mul(wasm_f32x4_splat(70.0f), vc3)),
                       wasm_f32x4_mul(wasm_f32x4_splat(15.0f), vc)),
        v_eighth);
    vb = plg0_5;  // m = 4
    MSIS_ACC(acc0, 4, 0); MSIS_ACC(acc4, 4, 4); MSIS_ACC(acc5, 4, 5);
    MSIS_ACC(acc7, 4, 7); MSIS_ACC(acc8, 4, 8); MSIS_ACC(acc9, 4, 9);

    vb = vc2;  // m = 6
    MSIS_ACC(acc0, 6, 0); MSIS_ACC(acc4, 6, 4); MSIS_ACC(acc5, 6, 5);
    vb = wasm_f32x4_mul(vc, plg0_3);  // m = 7
    MSIS_ACC(acc0, 7, 0); MSIS_ACC(acc4, 7, 4); MSIS_ACC(acc5, 7, 5);
    vb = wasm_f32x4_mul(vc, plg0_5);  // m = 8
    MSIS_ACC(acc0, 8, 0); MSIS_ACC(acc4, 8, 4); MSIS_ACC(acc5, 8, 5);

    vb = vc3;  // m = 9
    MSIS_ACC(acc4, 9, 4);
    vb = wasm_f32x4_mul(vc2, plg0_3);  // m = 10
    MSIS_ACC(acc4, 10, 4);
    vb = wasm_f32x4_mul(vc2, plg0_5);  // m = 11
    MSIS_ACC(acc4, 11, 4);
  }

  // Order 1 diurnal & longitudinal terms (m = 12..19, 34..50; m = 42, 51 are identically zero)
  const v128_t vstloc = wasm_v128_load(stloc_in);
  const v128_t vctloc = wasm_v128_load(ctloc_in);
  const v128_t vslong = wasm_v128_load(slong_in);
  const v128_t vclong = wasm_v128_load(clong_in);
  {
    const v128_t plg1_1 = vs;
    const v128_t plg1_2 = wasm_f32x4_mul(v_three, wasm_f32x4_mul(vc, vs));
    const v128_t plg1_3 = wasm_f32x4_mul(wasm_f32x4_splat(1.5f),
                                         wasm_f32x4_mul(wasm_f32x4_sub(wasm_f32x4_mul(v_five, vc2), v_one), vs));
    const v128_t plg1_4 = wasm_f32x4_mul(
        wasm_f32x4_splat(2.5f),
        wasm_f32x4_mul(wasm_f32x4_sub(wasm_f32x4_mul(v_seven, vc3), wasm_f32x4_mul(v_three, vc)), vs));
    const v128_t plg1_5 = wasm_f32x4_mul(
        wasm_f32x4_splat(1.875f),
        wasm_f32x4_mul(wasm_f32x4_add(wasm_f32x4_sub(wasm_f32x4_mul(wasm_f32x4_splat(21.0f), vc4),
                                                     wasm_f32x4_mul(wasm_f32x4_splat(14.0f), vc2)),
                                      v_one),
                       vs));
    const v128_t plg1_6 = wasm_f32x4_mul(
        wasm_f32x4_sub(wasm_f32x4_mul(v_eleven, wasm_f32x4_mul(vc, plg1_5)), wasm_f32x4_mul(wasm_f32x4_splat(6.0f), plg1_4)),
        wasm_f32x4_splat(0.2f));

    v128_t vb = wasm_f32x4_mul(plg1_1, vctloc);  // m = 12
    MSIS_ACC(acc0, 12, 0); MSIS_ACC(acc2, 12, 2); MSIS_ACC(acc3, 12, 3); MSIS_ACC(acc4, 12, 4); MSIS_ACC(acc5, 12, 5);
    MSIS_ACC(acc6, 12, 6); MSIS_ACC(acc7, 12, 7); MSIS_ACC(acc8, 12, 8); MSIS_ACC(acc9, 12, 9);
    vb = wasm_f32x4_mul(plg1_2, vctloc);  // m = 13
    MSIS_ACC(acc0, 13, 0); MSIS_ACC(acc4, 13, 4); MSIS_ACC(acc5, 13, 5);
    MSIS_ACC(acc7, 13, 7); MSIS_ACC(acc8, 13, 8); MSIS_ACC(acc9, 13, 9);
    vb = wasm_f32x4_mul(plg1_3, vctloc);  // m = 14
    MSIS_ACC(acc0, 14, 0); MSIS_ACC(acc4, 14, 4); MSIS_ACC(acc5, 14, 5);
    MSIS_ACC(acc7, 14, 7); MSIS_ACC(acc8, 14, 8); MSIS_ACC(acc9, 14, 9);
    vb = wasm_f32x4_mul(plg1_5, vctloc);  // m = 15
    MSIS_ACC(acc0, 15, 0); MSIS_ACC(acc4, 15, 4); MSIS_ACC(acc5, 15, 5); MSIS_ACC(acc8, 15, 8); MSIS_ACC(acc9, 15, 9);

    vb = wasm_f32x4_mul(plg1_1, vstloc);  // m = 16
    MSIS_ACC(acc0, 16, 0); MSIS_ACC(acc2, 16, 2); MSIS_ACC(acc3, 16, 3); MSIS_ACC(acc4, 16, 4); MSIS_ACC(acc5, 16, 5);
    MSIS_ACC(acc6, 16, 6); MSIS_ACC(acc7, 16, 7); MSIS_ACC(acc8, 16, 8); MSIS_ACC(acc9, 16, 9);
    vb = wasm_f32x4_mul(plg1_2, vstloc);  // m = 17
    MSIS_ACC(acc0, 17, 0); MSIS_ACC(acc4, 17, 4); MSIS_ACC(acc5, 17, 5);
    MSIS_ACC(acc7, 17, 7); MSIS_ACC(acc8, 17, 8); MSIS_ACC(acc9, 17, 9);
    vb = wasm_f32x4_mul(plg1_3, vstloc);  // m = 18
    MSIS_ACC(acc0, 18, 0); MSIS_ACC(acc4, 18, 4); MSIS_ACC(acc5, 18, 5);
    MSIS_ACC(acc7, 18, 7); MSIS_ACC(acc8, 18, 8); MSIS_ACC(acc9, 18, 9);
    vb = wasm_f32x4_mul(plg1_5, vstloc);  // m = 19
    MSIS_ACC(acc0, 19, 0); MSIS_ACC(acc4, 19, 4); MSIS_ACC(acc5, 19, 5); MSIS_ACC(acc8, 19, 8); MSIS_ACC(acc9, 19, 9);

    const v128_t c_p12 = wasm_f32x4_mul(vc, plg1_2);
    const v128_t c_p14 = wasm_f32x4_mul(vc, plg1_4);
    vb = wasm_f32x4_mul(plg1_1, vclong);  // m = 34
    MSIS_ACC(acc0, 34, 0); MSIS_ACC(acc4, 34, 4); MSIS_ACC(acc5, 34, 5); MSIS_ACC(acc7, 34, 7);
    vb = wasm_f32x4_mul(plg1_2, vclong);  // m = 35
    MSIS_ACC(acc0, 35, 0); MSIS_ACC(acc4, 35, 4); MSIS_ACC(acc5, 35, 5); MSIS_ACC(acc6, 35, 6);
    MSIS_ACC(acc7, 35, 7); MSIS_ACC(acc8, 35, 8); MSIS_ACC(acc9, 35, 9);
    vb = wasm_f32x4_mul(plg1_3, vclong);  // m = 36
    MSIS_ACC(acc0, 36, 0); MSIS_ACC(acc4, 36, 4); MSIS_ACC(acc5, 36, 5); MSIS_ACC(acc7, 36, 7);
    vb = wasm_f32x4_mul(plg1_4, vclong);  // m = 37
    MSIS_ACC(acc0, 37, 0); MSIS_ACC(acc4, 37, 4); MSIS_ACC(acc5, 37, 5); MSIS_ACC(acc6, 37, 6);
    MSIS_ACC(acc7, 37, 7); MSIS_ACC(acc8, 37, 8); MSIS_ACC(acc9, 37, 9);
    vb = wasm_f32x4_mul(plg1_5, vclong);  // m = 38
    MSIS_ACC(acc0, 38, 0); MSIS_ACC(acc4, 38, 4); MSIS_ACC(acc5, 38, 5);
    vb = wasm_f32x4_mul(plg1_6, vclong);  // m = 39
    MSIS_ACC(acc0, 39, 0); MSIS_ACC(acc4, 39, 4); MSIS_ACC(acc5, 39, 5);
    MSIS_ACC(acc7, 39, 7); MSIS_ACC(acc8, 39, 8); MSIS_ACC(acc9, 39, 9);
    vb = wasm_f32x4_mul(c_p12, vclong);  // m = 40
    MSIS_ACC(acc4, 40, 4);
    vb = wasm_f32x4_mul(c_p14, vclong);  // m = 41
    MSIS_ACC(acc4, 41, 4);

    vb = wasm_f32x4_mul(plg1_1, vslong);  // m = 43
    MSIS_ACC(acc0, 43, 0); MSIS_ACC(acc4, 43, 4); MSIS_ACC(acc5, 43, 5); MSIS_ACC(acc7, 43, 7);
    vb = wasm_f32x4_mul(plg1_2, vslong);  // m = 44
    MSIS_ACC(acc0, 44, 0); MSIS_ACC(acc4, 44, 4); MSIS_ACC(acc5, 44, 5); MSIS_ACC(acc6, 44, 6);
    MSIS_ACC(acc7, 44, 7); MSIS_ACC(acc8, 44, 8); MSIS_ACC(acc9, 44, 9);
    vb = wasm_f32x4_mul(plg1_3, vslong);  // m = 45
    MSIS_ACC(acc0, 45, 0); MSIS_ACC(acc4, 45, 4); MSIS_ACC(acc5, 45, 5); MSIS_ACC(acc7, 45, 7);
    vb = wasm_f32x4_mul(plg1_4, vslong);  // m = 46
    MSIS_ACC(acc0, 46, 0); MSIS_ACC(acc4, 46, 4); MSIS_ACC(acc5, 46, 5); MSIS_ACC(acc6, 46, 6);
    MSIS_ACC(acc7, 46, 7); MSIS_ACC(acc8, 46, 8); MSIS_ACC(acc9, 46, 9);
    vb = wasm_f32x4_mul(plg1_5, vslong);  // m = 47
    MSIS_ACC(acc0, 47, 0); MSIS_ACC(acc4, 47, 4); MSIS_ACC(acc5, 47, 5);
    vb = wasm_f32x4_mul(plg1_6, vslong);  // m = 48
    MSIS_ACC(acc0, 48, 0); MSIS_ACC(acc4, 48, 4); MSIS_ACC(acc5, 48, 5);
    MSIS_ACC(acc7, 48, 7); MSIS_ACC(acc8, 48, 8); MSIS_ACC(acc9, 48, 9);
    vb = wasm_f32x4_mul(c_p12, vslong);  // m = 49
    MSIS_ACC(acc4, 49, 4);
    vb = wasm_f32x4_mul(c_p14, vslong);  // m = 50
    MSIS_ACC(acc4, 50, 4);
  }

  // Order 2 semidiurnal & UT/longitude terms (m = 20..27, 52, 53, 55, 56; m = 54, 57 are identically zero)
  const v128_t vs2 = wasm_f32x4_mul(vs, vs);
  const v128_t s2tloc = wasm_f32x4_mul(v_two, wasm_f32x4_mul(vstloc, vctloc));
  const v128_t c2tloc = wasm_f32x4_sub(wasm_f32x4_mul(vctloc, vctloc), wasm_f32x4_mul(vstloc, vstloc));
  {
    const v128_t plg2_2 = wasm_f32x4_mul(v_three, vs2);
    const v128_t plg2_3 = wasm_f32x4_mul(wasm_f32x4_splat(15.0f), wasm_f32x4_mul(vs2, vc));
    const v128_t plg2_4 = wasm_f32x4_mul(wasm_f32x4_splat(7.5f),
                                         wasm_f32x4_mul(wasm_f32x4_sub(wasm_f32x4_mul(v_seven, vc2), v_one), vs2));
    const v128_t plg2_5 = wasm_f32x4_sub(wasm_f32x4_mul(v_three, wasm_f32x4_mul(vc, plg2_4)),
                                         wasm_f32x4_mul(v_two, plg2_3));

    v128_t vb = wasm_f32x4_mul(plg2_2, c2tloc);  // m = 20
    MSIS_ACC(acc0, 20, 0); MSIS_ACC(acc1, 20, 1); MSIS_ACC(acc2, 20, 2); MSIS_ACC(acc3, 20, 3); MSIS_ACC(acc4, 20, 4);
    MSIS_ACC(acc5, 20, 5); MSIS_ACC(acc6, 20, 6); MSIS_ACC(acc7, 20, 7); MSIS_ACC(acc8, 20, 8); MSIS_ACC(acc9, 20, 9);
    vb = wasm_f32x4_mul(plg2_3, c2tloc);  // m = 21
    MSIS_ACC(acc0, 21, 0); MSIS_ACC(acc1, 21, 1);
    vb = wasm_f32x4_mul(plg2_4, c2tloc);  // m = 22
    MSIS_ACC(acc0, 22, 0); MSIS_ACC(acc1, 22, 1); MSIS_ACC(acc2, 22, 2);
    MSIS_ACC(acc3, 22, 3); MSIS_ACC(acc5, 22, 5); MSIS_ACC(acc9, 22, 9);
    vb = wasm_f32x4_mul(plg2_5, c2tloc);  // m = 23
    MSIS_ACC(acc2, 23, 2);

    vb = wasm_f32x4_mul(plg2_2, s2tloc);  // m = 24
    MSIS_ACC(acc0, 24, 0); MSIS_ACC(acc1, 24, 1); MSIS_ACC(acc2, 24, 2); MSIS_ACC(acc3, 24, 3); MSIS_ACC(acc4, 24, 4);
    MSIS_ACC(acc5, 24, 5); MSIS_ACC(acc6, 24, 6); MSIS_ACC(acc7, 24, 7); MSIS_ACC(acc8, 24, 8); MSIS_ACC(acc9, 24, 9);
    vb = wasm_f32x4_mul(plg2_3, s2tloc);  // m = 25
    MSIS_ACC(acc0, 25, 0); MSIS_ACC(acc1, 25, 1);
    vb = wasm_f32x4_mul(plg2_4, s2tloc);  // m = 26
    MSIS_ACC(acc0, 26, 0); MSIS_ACC(acc1, 26, 1); MSIS_ACC(acc2, 26, 2);
    MSIS_ACC(acc3, 26, 3); MSIS_ACC(acc5, 26, 5); MSIS_ACC(acc9, 26, 9);
    vb = wasm_f32x4_mul(plg2_5, s2tloc);  // m = 27
    MSIS_ACC(acc2, 27, 2);

    const v128_t c2long = wasm_f32x4_sub(wasm_f32x4_mul(vclong, vclong), wasm_f32x4_mul(vslong, vslong));
    const v128_t s2long = wasm_f32x4_mul(v_two, wasm_f32x4_mul(vslong, vclong));
    const v128_t vcsec = wasm_f32x4_splat(static_cast<float>(tc.csec));
    const v128_t vssec = wasm_f32x4_splat(static_cast<float>(tc.ssec));
    const v128_t cmixed = wasm_f32x4_sub(wasm_f32x4_mul(vcsec, c2long), wasm_f32x4_mul(vssec, s2long));
    const v128_t smixed = wasm_f32x4_add(wasm_f32x4_mul(vssec, c2long), wasm_f32x4_mul(vcsec, s2long));
    vb = wasm_f32x4_mul(plg2_3, cmixed);  // m = 52
    MSIS_ACC(acc0, 52, 0); MSIS_ACC(acc4, 52, 4); MSIS_ACC(acc5, 52, 5); MSIS_ACC(acc7, 52, 7);
    vb = wasm_f32x4_mul(plg2_5, cmixed);  // m = 53
    MSIS_ACC(acc0, 53, 0); MSIS_ACC(acc4, 53, 4); MSIS_ACC(acc5, 53, 5); MSIS_ACC(acc7, 53, 7);
    vb = wasm_f32x4_mul(plg2_3, smixed);  // m = 55
    MSIS_ACC(acc0, 55, 0); MSIS_ACC(acc4, 55, 4); MSIS_ACC(acc5, 55, 5); MSIS_ACC(acc7, 55, 7);
    vb = wasm_f32x4_mul(plg2_5, smixed);  // m = 56
    MSIS_ACC(acc0, 56, 0); MSIS_ACC(acc4, 56, 4); MSIS_ACC(acc5, 56, 5); MSIS_ACC(acc7, 56, 7);
  }

  // Order 3 terdiurnal terms (m = 28..33)
  {
    const v128_t vs3 = wasm_f32x4_mul(vs2, vs);
    const v128_t plg3_3 = wasm_f32x4_mul(wasm_f32x4_splat(15.0f), vs3);
    const v128_t plg3_4 = wasm_f32x4_mul(wasm_f32x4_splat(105.0f), wasm_f32x4_mul(vs3, vc));
    const v128_t plg3_5 = wasm_f32x4_mul(
        wasm_f32x4_sub(wasm_f32x4_mul(wasm_f32x4_splat(9.0f), wasm_f32x4_mul(vc, plg3_4)), wasm_f32x4_mul(v_seven, plg3_3)),
        v_half);
    const v128_t plg3_6 = wasm_f32x4_mul(
        wasm_f32x4_sub(wasm_f32x4_mul(v_eleven, wasm_f32x4_mul(vc, plg3_5)),
                       wasm_f32x4_mul(wasm_f32x4_splat(8.0f), plg3_4)),
        wasm_f32x4_splat(1.0f / 3.0f));
    const v128_t s3tloc = wasm_f32x4_add(wasm_f32x4_mul(s2tloc, vctloc), wasm_f32x4_mul(c2tloc, vstloc));
    const v128_t c3tloc = wasm_f32x4_sub(wasm_f32x4_mul(c2tloc, vctloc), wasm_f32x4_mul(s2tloc, vstloc));

    v128_t vb = wasm_f32x4_mul(plg3_3, s3tloc);  // m = 28
    MSIS_ACC(acc0, 28, 0); MSIS_ACC(acc3, 28, 3); MSIS_ACC(acc4, 28, 4); MSIS_ACC(acc5, 28, 5);
    MSIS_ACC(acc7, 28, 7); MSIS_ACC(acc8, 28, 8); MSIS_ACC(acc9, 28, 9);
    vb = wasm_f32x4_mul(plg3_4, s3tloc);  // m = 29
    MSIS_ACC(acc0, 29, 0);
    vb = wasm_f32x4_mul(plg3_6, s3tloc);  // m = 30
    MSIS_ACC(acc0, 30, 0);

    vb = wasm_f32x4_mul(plg3_3, c3tloc);  // m = 31
    MSIS_ACC(acc0, 31, 0); MSIS_ACC(acc3, 31, 3); MSIS_ACC(acc4, 31, 4); MSIS_ACC(acc5, 31, 5);
    MSIS_ACC(acc7, 31, 7); MSIS_ACC(acc8, 31, 8); MSIS_ACC(acc9, 31, 9);
    vb = wasm_f32x4_mul(plg3_4, c3tloc);  // m = 32
    MSIS_ACC(acc0, 32, 0);
    vb = wasm_f32x4_mul(plg3_6, c3tloc);  // m = 33
    MSIS_ACC(acc0, 33, 0);
  }
  #undef MSIS_ACC

  const v128_t vg6 = wasm_f32x4_add(acc6, wasm_v128_load32_splat(&tc.wf_const[2]));
  const v128_t vg7 = wasm_f32x4_add(acc7, wasm_v128_load32_splat(&tc.wf_const[3]));
  const v128_t vg4 = wasm_f32x4_add(acc4, wasm_v128_load32_splat(&tc.wf_const[0]));
  const v128_t vg8 = wasm_f32x4_add(acc8, wasm_v128_load32_splat(&tc.wf_const[4]));

  auto promote_pair = [](v128_t vf, int hi) __attribute__((always_inline)) -> v128_t {
    return wasm_f64x2_promote_low_f32x4(hi ? wasm_i64x2_shuffle(vf, vf, 1, 1) : vf);
  };
  auto pack_f64x2_pair = [](v128_t lo, v128_t hi) __attribute__((always_inline)) -> v128_t {
    return wasm_i32x4_shuffle(wasm_f32x4_demote_f64x2_zero(lo), wasm_f32x4_demote_f64x2_zero(hi), 0, 1, 4, 5);
  };

  const v128_t vd_one = wasm_f64x2_splat(1.0);
  const v128_t vd_zlb = wasm_f64x2_splat(ts.zlb);
  auto baro_pair = [&](int off, v128_t& out_log_tr, v128_t& out_slope_xm,
                       v128_t& out_L2, v128_t& out_L1, v128_t& out_L7,
                       v128_t& out_g10_ao, v128_t& out_tinf, v128_t& out_tlb,
                       v128_t& out_s_grad, v128_t& out_gamma_1) __attribute__((always_inline)) {
    const int hi = off >> 1;
    const v128_t vh_d = wasm_v128_load(h_in + off);
    const v128_t vc_d = promote_pair(vc, hi);
    const v128_t vc2lat_d = wasm_f64x2_sub(vd_one, wasm_f64x2_mul(wasm_f64x2_splat(2.0), wasm_f64x2_mul(vc_d, vc_d)));
    const v128_t vgsurf_d = wasm_f64x2_mul(wasm_f64x2_splat(980.616),
                                           wasm_f64x2_sub(vd_one, wasm_f64x2_mul(wasm_f64x2_splat(0.0026373), vc2lat_d)));
    const v128_t vx_re_d = wasm_f64x2_mul(wasm_f64x2_splat(2.27E-9 / 3.085462E-6), vc2lat_d);
    const v128_t vre_d = wasm_f64x2_mul(
        wasm_f64x2_mul(vgsurf_d, wasm_f64x2_splat(2.0E-5 / 3.085462E-6)),
        wasm_f64x2_sub(vd_one, wasm_f64x2_mul(vx_re_d, wasm_f64x2_sub(vd_one, vx_re_d))));
    const v128_t vglb_d = wasm_f64x2_add(
        wasm_f64x2_splat(ts.glb_p[0]),
        wasm_f64x2_mul(vc2lat_d, wasm_f64x2_add(wasm_f64x2_splat(ts.glb_p[1]),
                                                wasm_f64x2_mul(vc2lat_d, wasm_f64x2_add(wasm_f64x2_splat(ts.glb_p[2]),
                                                                                        wasm_f64x2_mul(vc2lat_d, wasm_f64x2_splat(ts.glb_p[3])))))));

    const v128_t vg0_d = wasm_f64x2_add(promote_pair(acc0, hi), wasm_f64x2_splat(tc.g_const[0]));
    const v128_t vg1_d = wasm_f64x2_add(promote_pair(acc1, hi), wasm_f64x2_splat(tc.g_const[1]));
    const v128_t vg2_d = wasm_f64x2_add(promote_pair(acc2, hi), wasm_f64x2_splat(tc.g_const[2]));
    const v128_t vg3_d = wasm_f64x2_add(promote_pair(acc3, hi), wasm_f64x2_splat(tc.g_const[3]));
    const v128_t vg5_d = wasm_f64x2_add(promote_pair(acc5, hi), wasm_f64x2_splat(tc.g_const[5]));
    const v128_t vg9_d = wasm_f64x2_add(promote_pair(acc9, hi), wasm_f64x2_splat(tc.g_const[9]));
    const v128_t vg10_d = wasm_f64x2_add(promote_pair(acc10, hi), wasm_f64x2_splat(tc.g_const[10]));

    const v128_t vtinf_d = wasm_f64x2_mul(wasm_f64x2_splat(ts.base_pt), wasm_f64x2_add(vd_one, vg0_d));
    const v128_t vg0_grav_d = wasm_f64x2_mul(wasm_f64x2_splat(ts.base_ps), wasm_f64x2_add(vd_one, vg1_d));
    const v128_t vtlb_d = wasm_f64x2_mul(wasm_f64x2_splat(ts.base_tlb), wasm_f64x2_add(vd_one, vg2_d));
    const v128_t vdt_inf_d = wasm_f64x2_sub(vtinf_d, vtlb_d);
    const v128_t vre_ph_d = wasm_f64x2_add(vre_d, vh_d);
    const v128_t vgt_d = wasm_f64x2_mul(vg0_grav_d, wasm_f64x2_mul(wasm_f64x2_splat(831.4), vtinf_d));
    const v128_t vdt_reph = wasm_f64x2_mul(vdt_inf_d, vre_ph_d);
    const v128_t vinv_abc = wasm_f64x2_div(vd_one, wasm_f64x2_mul(vdt_reph, vgt_d));
    const v128_t vinv_dt_reph = wasm_f64x2_mul(vinv_abc, vgt_d);
    const v128_t vs_grad_d = wasm_f64x2_mul(vg0_grav_d, wasm_f64x2_mul(vinv_dt_reph, vre_ph_d));
    const v128_t vzg2_d = wasm_f64x2_mul(wasm_f64x2_mul(wasm_f64x2_sub(vh_d, vd_zlb), wasm_f64x2_add(vre_d, vd_zlb)),
                                         wasm_f64x2_mul(vinv_dt_reph, vdt_inf_d));
    const v128_t vszg2_d = wasm_f64x2_mul(vs_grad_d, vzg2_d);
    const v128_t vtt_d = wasm_f64x2_sub(vtinf_d, wasm_f64x2_mul(vdt_inf_d, fm::exp2_f64x2(wasm_f64x2_neg(vszg2_d))));
    const v128_t vgamma_1_d = wasm_f64x2_mul(vglb_d, wasm_f64x2_mul(vdt_inf_d, wasm_f64x2_mul(vinv_abc, vdt_reph)));
    const v128_t vlog_tr_d = fm::log2_f64x2(wasm_f64x2_div(vtlb_d, vtt_d));
    const v128_t vslope_xm_d = wasm_f64x2_mul(vgamma_1_d, wasm_f64x2_sub(vlog_tr_d, vszg2_d));

    out_log_tr = vlog_tr_d;
    out_slope_xm = vslope_xm_d;
    out_L2 = wasm_f64x2_add(wasm_f64x2_add(vg3_d, vlog_tr_d), wasm_f64x2_mul(wasm_f64x2_splat(28.0), vslope_xm_d));
    out_L1 = wasm_f64x2_add(wasm_f64x2_add(vg5_d, vlog_tr_d), wasm_f64x2_mul(wasm_f64x2_splat(16.0), vslope_xm_d));
    out_L7 = wasm_f64x2_add(wasm_f64x2_add(vg9_d, vlog_tr_d), wasm_f64x2_mul(wasm_f64x2_splat(14.0), vslope_xm_d));
    const v128_t vgamma_ao_d = wasm_f64x2_mul(wasm_f64x2_mul(vglb_d, wasm_f64x2_splat(16.0 / (831.4 * ts.tho))), vzg2_d);
    out_g10_ao = wasm_f64x2_sub(vg10_d, vgamma_ao_d);
    out_tinf = vtinf_d;
    out_tlb = vtlb_d;
    out_s_grad = vs_grad_d;
    out_gamma_1 = vgamma_1_d;
  };

  v128_t ltr0, slp0, L2_0, L1_0, L7_0, g10ao_0, tinf0, tlb0, sgr0, gam1_0;
  v128_t ltr1, slp1, L2_1, L1_1, L7_1, g10ao_1, tinf1, tlb1, sgr1, gam1_1;
  baro_pair(0, ltr0, slp0, L2_0, L1_0, L7_0, g10ao_0, tinf0, tlb0, sgr0, gam1_0);
  if (n_lanes > 2) {
    baro_pair(2, ltr1, slp1, L2_1, L1_1, L7_1, g10ao_1, tinf1, tlb1, sgr1, gam1_1);
  } else {
    ltr1 = ltr0; slp1 = slp0; L2_1 = L2_0; L1_1 = L1_0; L7_1 = L7_0; g10ao_1 = g10ao_0;
    tinf1 = tinf0; tlb1 = tlb0; sgr1 = sgr0; gam1_1 = gam1_0;
  }

  const v128_t vc2lat_f = wasm_f32x4_sub(v_one, wasm_f32x4_mul(v_two, vc2));
  auto poly3_lat = [&](const float p[4]) __attribute__((always_inline)) -> v128_t {
    return wasm_f32x4_add(
        wasm_f32x4_splat(p[0]),
        wasm_f32x4_mul(vc2lat_f, wasm_f32x4_add(wasm_f32x4_splat(p[1]),
                                                wasm_f32x4_mul(vc2lat_f, wasm_f32x4_add(wasm_f32x4_splat(p[2]),
                                                                                        wasm_f32x4_mul(vc2lat_f, wasm_f32x4_splat(p[3])))))));
  };

  const v128_t vh = pack_f64x2_pair(wasm_v128_load(h_in + 0), wasm_v128_load(h_in + (n_lanes > 2 ? 2 : 0)));
  const v128_t vlog_tr = pack_f64x2_pair(ltr0, ltr1);
  const v128_t vslope_xm = pack_f64x2_pair(slp0, slp1);
  const v128_t vlog_tr_062 = wasm_f32x4_mul(wasm_f32x4_splat(0.62f), vlog_tr);

  const v128_t wm2 = wasm_f32x4_mul(wasm_f32x4_splat(static_cast<float>(28.0 * ts.dlb0[0])),
                                    fm::exp4_f32x4(pack_f64x2_pair(L2_0, L2_1)));
  const v128_t wm0 = wasm_f32x4_mul(
      wasm_f32x4_splat(static_cast<float>(4.0 * ts.dlb0[1])),
      fm::exp4_f32x4(wasm_f32x4_add(wasm_f32x4_add(vg4, vlog_tr_062), wasm_f32x4_mul(wasm_f32x4_splat(4.0f), vslope_xm))));
  const v128_t wm6 = wasm_f32x4_mul(wasm_f32x4_splat(static_cast<float>(ts.dlb0[5])),
                                    fm::exp4_f32x4(wasm_f32x4_add(wasm_f32x4_add(vg8, vlog_tr_062), vslope_xm)));

  v128_t wm3 = wasm_f32x4_splat(0.0f);
  const v128_t m3 = wasm_f32x4_gt(wasm_f32x4_mul(wasm_f32x4_splat(16.0f), vslope_xm), wasm_f32x4_splat(-42.0f));
  if (wasm_v128_any_true(m3)) {
    const float rc32 = static_cast<float>(ts.rc32_0 * (1.0 + ts.rc32_dfa * tc.dfa));
    const v128_t vdh32 = wasm_f32x4_sub(vh, wasm_f32x4_splat(static_cast<float>(ts.zcc32)));
    const v128_t ve1 = fm::exp4_f32x4(wasm_f32x4_mul(vdh32, wasm_f32x4_splat(static_cast<float>(1.0 / ts.hcc32))));
    const v128_t ve2 = fm::exp4_f32x4(wasm_f32x4_mul(vdh32, wasm_f32x4_splat(static_cast<float>(1.0 / ts.hcc232))));
    const v128_t vcc32 = wasm_f32x4_div(wasm_f32x4_splat(rc32),
                                        wasm_f32x4_add(v_one, wasm_f32x4_mul(v_half, wasm_f32x4_add(ve1, ve2))));
    const v128_t vL3 = wasm_f32x4_add(
        wasm_f32x4_add(vg6, vlog_tr),
        wasm_f32x4_add(wasm_f32x4_mul(wasm_f32x4_splat(32.0f), vslope_xm), vcc32));
    wm3 = wasm_v128_and(m3, wasm_f32x4_mul(wasm_f32x4_splat(static_cast<float>(32.0 * ts.dlb0[3])), fm::exp4_f32x4(vL3)));
  }

  v128_t wm4 = wasm_f32x4_splat(0.0f);
  const v128_t m4 = wasm_f32x4_gt(wasm_f32x4_mul(wasm_f32x4_splat(24.0f), vslope_xm), wasm_f32x4_splat(-42.0f));
  if (wasm_v128_any_true(m4)) {
    const v128_t vL4 = wasm_f32x4_add(wasm_f32x4_add(vg7, wasm_f32x4_mul(wasm_f32x4_splat(1.17f), vlog_tr)),
                                      wasm_f32x4_mul(wasm_f32x4_splat(40.0f), vslope_xm));
    wm4 = wasm_v128_and(m4, wasm_f32x4_mul(wasm_f32x4_splat(static_cast<float>(40.0 * ts.dlb0[4])), fm::exp4_f32x4(vL4)));
  }

  v128_t vL7_f = pack_f64x2_pair(L7_0, L7_1);
  const v128_t vvalid_mask = wasm_i32x4_lt(wasm_i32x4_const(0, 1, 2, 3), wasm_i32x4_splat(n_lanes));
  const v128_t vm_lo_f = wasm_v128_and(vvalid_mask, wasm_f32x4_le(vh, wasm_f32x4_splat(450.0f)));
  if (wasm_v128_any_true(vm_lo_f)) {
    const v128_t vtinf_f = pack_f64x2_pair(tinf0, tinf1);
    const v128_t vtlb_f = pack_f64x2_pair(tlb0, tlb1);
    const v128_t vs_grad_f = pack_f64x2_pair(sgr0, sgr1);
    const v128_t vgamma_1_f = pack_f64x2_pair(gam1_0, gam1_1);
    const v128_t vr_zlb_za = poly3_lat(ts.rzlb_za_p);
    const v128_t vzg2_za = wasm_f32x4_mul(wasm_f32x4_splat(static_cast<float>(ts.za - ts.zlb)), vr_zlb_za);
    const v128_t vszg2_za = wasm_f32x4_mul(vs_grad_f, vzg2_za);
    const v128_t vta = wasm_f32x4_sub(vtinf_f, wasm_f32x4_mul(wasm_f32x4_sub(vtinf_f, vtlb_f), fm::exp4_f32x4(wasm_f32x4_neg(vszg2_za))));
    const v128_t vd_cc1 = wasm_f32x4_add(v_one, fm::exp4_f32x4(wasm_f32x4_mul(wasm_f32x4_sub(vh, wasm_f32x4_splat(static_cast<float>(ts.zc14))),
                                                                              wasm_f32x4_splat(static_cast<float>(ts.inv_hc14)))));
    const v128_t vd_cc2 = wasm_f32x4_add(v_one, fm::exp4_f32x4(wasm_f32x4_mul(wasm_f32x4_sub(vh, wasm_f32x4_splat(static_cast<float>(ts.zcc14))),
                                                                              wasm_f32x4_splat(static_cast<float>(ts.inv_hcc14)))));
    const v128_t vd_cc12 = wasm_f32x4_mul(vd_cc1, vd_cc2);
    const v128_t vinv_3 = wasm_f32x4_div(v_one, wasm_f32x4_mul(vta, vd_cc12));
    const v128_t vys0 = wasm_f32x4_mul(vinv_3, vd_cc12);
    const v128_t vinv_cc12 = wasm_f32x4_mul(vinv_3, vta);
    const v128_t vdta = wasm_f32x4_mul(wasm_f32x4_mul(wasm_f32x4_sub(vtinf_f, vta), vs_grad_f),
                                       wasm_f32x4_mul(vr_zlb_za, vr_zlb_za));
    const v128_t vzgdif = poly3_lat(ts.zgdif_p);
    const v128_t vyd1 = wasm_f32x4_neg(wasm_f32x4_mul(wasm_f32x4_mul(vdta, wasm_f32x4_mul(vys0, vys0)), vzgdif));
    const v128_t vs14 = wasm_f32x4_add(wasm_f32x4_splat(static_cast<float>(ts.s14_c)),
                                       wasm_f32x4_add(wasm_f32x4_mul(wasm_f32x4_splat(static_cast<float>(ts.s14_ys)), vys0),
                                                      wasm_f32x4_mul(wasm_f32x4_splat(static_cast<float>(ts.s14_yd)), vyd1)));
    const v128_t vu = wasm_f32x4_mul(vc, wasm_f32x4_splat(static_cast<float>(tc.cd14_0)));
    auto poly3_u = [&](const double p[4]) __attribute__((always_inline)) -> v128_t {
      return wasm_f32x4_add(
          wasm_f32x4_splat(static_cast<float>(p[0])),
          wasm_f32x4_mul(vu, wasm_f32x4_add(wasm_f32x4_splat(static_cast<float>(p[1])),
                                            wasm_f32x4_mul(vu, wasm_f32x4_add(wasm_f32x4_splat(static_cast<float>(p[2])),
                                                                              wasm_f32x4_mul(vu, wasm_f32x4_splat(static_cast<float>(p[3]))))))));
    };
    const v128_t vs28 = wasm_f32x4_add(poly3_u(ts.s28_p[0]),
                                       wasm_f32x4_add(wasm_f32x4_mul(poly3_u(ts.s28_p[1]), vys0),
                                                      wasm_f32x4_mul(poly3_u(ts.s28_p[2]), vyd1)));
    const v128_t vslope_za = wasm_f32x4_mul(vgamma_1_f,
                                            wasm_f32x4_sub(fm::log4_f32x4(wasm_f32x4_mul(vtlb_f, vys0)), vszg2_za));
    const v128_t vgamm_1 = poly3_lat(ts.gamm1_p);
    const v128_t vdiff14 = wasm_f32x4_sub(vslope_za, wasm_f32x4_mul(vgamm_1, vs14));
    const v128_t vldm = wasm_f32x4_mul(wasm_f32x4_splat(static_cast<float>(14.0 - ts.xmm)), wasm_f32x4_sub(vdiff14, vslope_xm));
    v128_t vdL7 = wasm_f32x4_splat(0.0f);
    const v128_t vylog = wasm_f32x4_mul(wasm_f32x4_splat(static_cast<float>(ts.a_net)), vldm);
    if (__builtin_expect(wasm_v128_any_true(wasm_v128_and(vm_lo_f, wasm_f32x4_ge(vylog, wasm_f32x4_splat(-10.0f)))), 0)) {
      const v128_t vsoft = wasm_f32x4_mul(fm::log4_f32x4(wasm_f32x4_add(v_one, fm::exp4_f32x4(vylog))),
                                          wasm_f32x4_splat(static_cast<float>(ts.inv_a_net)));
      const v128_t vm_gt10 = wasm_f32x4_gt(vylog, wasm_f32x4_splat(10.0f));
      const v128_t vm_ge_m10 = wasm_f32x4_ge(vylog, wasm_f32x4_splat(-10.0f));
      vdL7 = wasm_v128_and(vm_ge_m10, wasm_v128_bitselect(vldm, vsoft, vm_gt10));
    }
    const v128_t vg3_m_g9 = wasm_f32x4_add(wasm_f32x4_sub(acc3, acc9),
                                           wasm_f32x4_splat(static_cast<float>(tc.g_const[3] - tc.g_const[9])));
    const v128_t vrl = wasm_f32x4_sub(
        wasm_f32x4_add(wasm_f32x4_add(wasm_f32x4_splat(static_cast<float>(ts.log_dlb28_14_mix)), vg3_m_g9),
                       wasm_f32x4_mul(wasm_f32x4_splat(static_cast<float>(28.0 - ts.xmm)),
                                      wasm_f32x4_sub(vslope_za, wasm_f32x4_mul(vgamm_1, vs28)))),
        wasm_f32x4_mul(wasm_f32x4_splat(static_cast<float>(14.0 - ts.xmm)), vdiff14));
    const v128_t vcc1 = wasm_f32x4_mul(vrl, wasm_f32x4_mul(vinv_cc12, vd_cc2));
    const v128_t vcc2 = wasm_f32x4_mul(wasm_f32x4_splat(static_cast<float>(ts.rc14)), wasm_f32x4_mul(vinv_cc12, vd_cc1));
    vdL7 = wasm_f32x4_add(vdL7, wasm_f32x4_add(vcc1, vcc2));
    vL7_f = wasm_f32x4_add(vL7_f, wasm_v128_and(vm_lo_f, vdL7));
  }
  const v128_t wm7 = wasm_f32x4_mul(wasm_f32x4_splat(static_cast<float>(14.0 * ts.dlb0[6])),
                                    fm::exp4_f32x4(vL7_f));

  const v128_t vexp_zmho = fm::exp4_f32x4(
      wasm_f32x4_mul(wasm_f32x4_sub(wasm_f32x4_splat(static_cast<float>(ts.zmho)), vh),
                     wasm_f32x4_splat(static_cast<float>(1.0 / ts.zsht))));
  const v128_t vzmf = poly3_lat(ts.zmho_fac_p);
  const v128_t wm8 = wasm_f32x4_mul(
      wasm_f32x4_splat(static_cast<float>(16.0 * ts.dlb0[7])),
      fm::exp4_f32x4(wasm_f32x4_sub(pack_f64x2_pair(g10ao_0, g10ao_1),
                                    wasm_f32x4_mul(vzmf, wasm_f32x4_sub(vexp_zmho, v_one)))));

  const v128_t vsum_other = wasm_f32x4_add(
      wasm_f32x4_add(wasm_f32x4_add(wm0, wm2), wasm_f32x4_add(wm3, wm4)),
      wasm_f32x4_add(wm6, wasm_f32x4_add(wm7, wm8)));
  const v128_t v_scale_rho = wasm_f64x2_splat(1.66E-21);
  const v128_t v_o_scale = wasm_f64x2_splat(1.66E-21 * 16.0 * ts.dlb0[2]);
  wasm_v128_store(rho_out + 0,
                  wasm_f64x2_add(wasm_f64x2_mul(v_o_scale, fm::exp2_f64x2(L1_0)),
                                 wasm_f64x2_mul(v_scale_rho, wasm_f64x2_promote_low_f32x4(vsum_other))));
  if (n_lanes > 2) {
    wasm_v128_store(rho_out + 2,
                    wasm_f64x2_add(wasm_f64x2_mul(v_o_scale, fm::exp2_f64x2(L1_1)),
                                   wasm_f64x2_mul(v_scale_rho,
                                                  wasm_f64x2_promote_low_f32x4(wasm_i64x2_shuffle(vsum_other, vsum_other, 1, 1)))));
  }
#else
  for (int i = 0; i < n_lanes; ++i) {
    rho_out[i] = msis_density_hi_trig(tc, c_in[i], s_in[i], slong_in[i], clong_in[i], stloc_in[i], ctloc_in[i], h_in[i]);
  }
#endif
}

inline double msis_density_prepared(const ThermoTimeCache& tc, double lat, double lon, double h, const drag::Flux& f) {
  constexpr double dgtr = 1.74533E-2, hr = 0.2618;
  const double lat_deg = lat * (1.0 / kDeg);
  const double lon_deg = lon * (1.0 / kDeg);
  double lst = tc.sec_hr + lon_deg * (1.0 / 15.0);
  lst -= 24.0 * std::floor(lst * (1.0 / 24.0));
  if (h > 325.0) {
    double c, s, stloc, ctloc, slong, clong;
    fm::sincos(lat_deg * dgtr, c, s);
    fm::sincos(hr * lst, stloc, ctloc);
    fm::sincos(dgtr * lon_deg, slong, clong);
    return msis_density_hi_trig(tc, c, s, slong, clong, stloc, ctloc, h);
  }
  static const nrlmsise00::nrlmsise_flags kFlags = []() {
    nrlmsise00::nrlmsise_flags fl{};
    fl.switches[0] = 0;
    for (int k = 1; k < 24; ++k) fl.switches[k] = 1;
    nrlmsise00::tselec(&fl);
    return fl;
  }();
  nrlmsise00::nrlmsise_input in{};
  nrlmsise00::nrlmsise_output out{};
  nrlmsise00::nrlmsise_flags flags = kFlags;
  in.doy = tc.doy;
  in.sec = tc.sec;
  in.alt = h;
  in.g_lat = lat_deg;
  in.g_long = lon_deg;
  in.lst = lst;
  in.f107A = f.fbar;
  in.f107 = f.f;
  in.ap = f.ap;
  in.ap_a = nullptr;
  nrlmsise00::gtd7d(&in, &flags, &out);
  return out.d[5] * 1000.0;  // g/cm^3 -> kg/m^3
}

/// NRLMSISE-00 total mass density (kg/m^3) at geodetic latitude and longitude (rad), geodetic height (km) and d50 (UTC),
/// with drivers f: the day of year and UT seconds of d50, local solar time = UT + longitude / 15.
inline double msis_density(double d50, double lat, double lon, double h, const drag::Flux& f) {
  static const nrlmsise00::nrlmsise_flags kFlags = []() {
    nrlmsise00::nrlmsise_flags fl{};
    fl.switches[0] = 0;
    for (int k = 1; k < 24; ++k) fl.switches[k] = 1;
    nrlmsise00::tselec(&fl);
    return fl;
  }();
  const auto tc = prepare_msis_time(d50, f);
  const double lat_deg = lat * (1.0 / kDeg);
  const double lon_deg = lon * (1.0 / kDeg);
  double lst = tc.sec_hr + lon_deg * (1.0 / 15.0);
  lst -= 24.0 * std::floor(lst * (1.0 / 24.0));
  nrlmsise00::nrlmsise_input in{};
  nrlmsise00::nrlmsise_output out{};
  nrlmsise00::nrlmsise_flags flags = kFlags;
  in.doy = tc.doy;
  in.sec = tc.sec;
  in.alt = h;
  in.g_lat = lat_deg;
  in.g_long = lon_deg;
  in.lst = lst;
  in.f107A = f.fbar;
  in.f107 = f.f;
  in.ap = f.ap;
  in.ap_a = nullptr;
  nrlmsise00::gtd7d(&in, &flags, &out);
  return out.d[5] * 1000.0;  // g/cm^3 -> kg/m^3
}

/// Longitude in [-pi, pi).
inline double wrap_pi(double x) {
  double r = (x + kPi) - kTwoPi * std::floor((x + kPi) * (1.0 / kTwoPi));
  if (r >= kTwoPi) r -= kTwoPi;
  return r - kPi;
}

}  // namespace atm
}  // namespace sdnap
