#include "conjunction/earth_orientation.h"
#include <algorithm>
#include <cmath>
extern "C" {
int eraUtctai(double, double, double *, double *);
int eraTaitt(double, double, double *, double *);
int eraUtcut1(double, double, double, double *, double *);
void eraXys06a(double, double, double *, double *, double *);
void eraC2ixys(double, double, double, double[3][3]);
double eraEra00(double, double);
double eraSp00(double, double);
void eraPom00(double, double, double, double[3][3]);
void eraC2tcio(double[3][3], double, double[3][3], double[3][3]);
void eraBp06(double, double, double[3][3], double[3][3], double[3][3]);
}
namespace conjunction {
bool earth_orientation_at(const std::vector<EarthOrientation> &rows, double jd,
                          EarthOrientation &e) {
  if (rows.empty())
    return false;
  // One row is an explicitly supplied constant EOP solution. A series must
  // bracket every requested epoch; no implicit extrapolation or UT1=UTC.
  if (rows.size() == 1) {
    e = rows.front();
    return true;
  }
  if (jd < rows.front().jd || jd > rows.back().jd)
    return false;
  auto it = std::lower_bound(rows.begin(), rows.end(), jd,
                             [](const auto &a, double b) { return a.jd < b; });
  if (it == rows.begin()) {
    e = *it;
    return true;
  }
  const auto &a = *(it - 1);
  const auto &b = *it;
  double f = (jd - a.jd) / (b.jd - a.jd);
  e.jd = jd;
  e.xp = a.xp + (b.xp - a.xp) * f;
  e.yp = a.yp + (b.yp - a.yp) * f;
  e.dx = a.dx + (b.dx - a.dx) * f;
  e.dy = a.dy + (b.dy - a.dy) * f;
  e.lod = a.lod + (b.lod - a.lod) * f;
  // Interpolate UT1-TAI, not the discontinuous UT1-UTC across a leap second.
  auto dat = [](double t) {
    double t1, t2;
    eraUtctai(t, 0, &t1, &t2);
    return ((t1 - t) + t2) * 86400.;
  };
  double da = dat(a.jd), db = dat(b.jd);
  e.dut1 = (a.dut1 - da) * (1 - f) + (b.dut1 - db) * f + dat(jd);
  return true;
}
namespace {
bool earth_matrix(double jd, double offset_seconds, const EarthOrientation &e,
                  bool eme, double r[3][3]) {
  double tai1, tai2, tt1, tt2, u1, u2;
  // Keep sub-day quantities separate to avoid 40 us JD rounding in the
  // rotation derivative. ERFA owns UTC/leap-second conversion.
  double day = std::floor(jd - 0.5) + 0.5, fraction = jd - day;
  if (eraUtctai(day, fraction, &tai1, &tai2) < 0 ||
      eraTaitt(tai1, tai2, &tt1, &tt2) < 0 ||
      eraUtcut1(day, fraction, e.dut1, &u1, &u2) < 0)
    return false;
  tt2 += offset_seconds / 86400.;
  u2 += offset_seconds * (1 - e.lod / 86400.) / 86400.;
  double x, y, s, ci[3][3], pm[3][3], ct[3][3];
  eraXys06a(tt1, tt2, &x, &y, &s);
  eraC2ixys(x + e.dx, y + e.dy, s, ci);
  eraPom00(e.xp, e.yp, eraSp00(tt1, tt2), pm);
  eraC2tcio(ci, eraEra00(u1, u2), pm, ct);
  double bias[3][3], prec[3][3], bp[3][3];
  eraBp06(2451545., 0, bias, prec, bp);
  for (int i = 0; i < 3; ++i)
    for (int j = 0; j < 3; ++j) {
      r[i][j] = eme ? 0 : ct[j][i];
      if (eme)
        for (int k = 0; k < 3; ++k)
          r[i][j] += bias[i][k] * ct[j][k];
    }
  return true;
}
} // namespace
bool itrf_to_inertial(double jd, const EarthOrientation &e, bool eme,
                      double j[6][6]) {
  double r[3][3], before[3][3], after[3][3];
  if (!earth_matrix(jd, 0, e, eme, r) ||
      !earth_matrix(jd, -.5, e, eme, before) ||
      !earth_matrix(jd, .5, e, eme, after))
    return false;
  for (int a = 0; a < 6; ++a)
    for (int b = 0; b < 6; ++b)
      j[a][b] = 0;
  for (int a = 0; a < 3; ++a)
    for (int b = 0; b < 3; ++b) {
      j[a][b] = j[a + 3][b + 3] = r[a][b];
      // Central derivative, O(omega^3 h^2): < 0.2 micrometres/s at 7000 km.
      j[a + 3][b] = after[a][b] - before[a][b];
    }
  return true;
}
void transform_ephemeris_point(EphemerisPoint &p, const double j[6][6]) {
  double a[6] = {p.x, p.y, p.z, p.vx, p.vy, p.vz}, b[6] = {};
  for (int i = 0; i < 6; ++i)
    for (int k = 0; k < 6; ++k)
      b[i] += j[i][k] * a[k];
  p.x = b[0];
  p.y = b[1];
  p.z = b[2];
  p.vx = b[3];
  p.vy = b[4];
  p.vz = b[5];
}
void transform_ephemeris_covariance(std::array<double, 21> &c,
                                    const double j[6][6]) {
  double a[6][6] = {}, b[6][6] = {};
  size_t n = 0;
  for (int i = 0; i < 6; ++i)
    for (int k = 0; k <= i; ++k)
      a[i][k] = a[k][i] = c[n++];
  for (int i = 0; i < 6; ++i)
    for (int k = 0; k < 6; ++k)
      for (int p = 0; p < 6; ++p)
        for (int q = 0; q < 6; ++q)
          b[i][k] += j[i][p] * a[p][q] * j[k][q];
  n = 0;
  for (int i = 0; i < 6; ++i)
    for (int k = 0; k <= i; ++k)
      c[n++] = b[i][k];
}
} // namespace conjunction
