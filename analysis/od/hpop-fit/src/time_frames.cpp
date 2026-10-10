#include "time_frames.hpp"

#include <cmath>
#include <cstdio>
#include <cstring>
#include <functional>

// macOS <math.h> defines SING, an SDS LCC enumerator.
#ifdef SING
#undef SING
#endif
#include "PRW_generated.h"
#include "EOP_generated.h"
#include "erfa.h"
#include "erfam.h"
#include "axis_engine.hpp"
#include "eop_series.hpp"

namespace odhpop {

namespace {

bool split_seconds(const char* s, int* whole, double* frac) {
  // "SS" or "SS.fff..." -> whole seconds and fraction, kept exact in decimal.
  if (!std::isdigit(static_cast<unsigned char>(s[0])) ||
      !std::isdigit(static_cast<unsigned char>(s[1])))
    return false;
  *whole = (s[0] - '0') * 10 + (s[1] - '0');
  *frac = 0.0;
  const char* p = s + 2;
  if (*p == '.') {
    double scale = 0.1;
    ++p;
    while (std::isdigit(static_cast<unsigned char>(*p))) {
      *frac += (*p - '0') * scale;
      scale *= 0.1;
      ++p;
    }
  }
  while (*p == 'Z' || *p == ' ' || *p == '\r' || *p == '\n' || *p == '\t') ++p;
  return *p == '\0';
}

bool from_fields(int y, int mo, int d, int h, int mi, int sec, double frac, UtcEpoch* out) {
  double d1 = 0, d2 = 0;
  if (eraDtf2d("UTC", y, mo, d, h, mi, sec + frac, &d1, &d2) < 0) return false;
  // ERFA returns (2400000.5, MJD + fraction); keep the whole days in jd1 so
  // jd2 is the day fraction alone (resolution 1e-11 s, not 0.6 us).
  const double whole = std::floor(d2);
  out->jd1 = d1 + whole;
  out->jd2 = d2 - whole;
  return true;
}

}  // namespace

bool parse_iso_utc(const std::string& text, UtcEpoch* out) {
  int y = 0, mo = 0, d = 0, h = 0, mi = 0, n = 0;
  std::string t = text;
  while (!t.empty() && (t.front() == ' ' || t.front() == '\t')) t.erase(t.begin());
  if (std::sscanf(t.c_str(), "%4d-%2d-%2dT%2d:%2d:%n", &y, &mo, &d, &h, &mi, &n) == 5 && n > 0) {
    int sec = 0;
    double frac = 0;
    if (!split_seconds(t.c_str() + n, &sec, &frac)) return false;
    return from_fields(y, mo, d, h, mi, sec, frac, out);
  }
  int doy = 0;
  n = 0;
  if (std::sscanf(t.c_str(), "%4d-%3dT%2d:%2d:%n", &y, &doy, &h, &mi, &n) == 4 && n > 0) {
    int sec = 0;
    double frac = 0;
    if (!split_seconds(t.c_str() + n, &sec, &frac)) return false;
    double jd0 = 0, mjd = 0;
    if (eraCal2jd(y, 1, 1, &jd0, &mjd) != 0) return false;
    int yy, mm, dd;
    double fd;
    if (eraJd2cal(jd0, mjd + doy - 1, &yy, &mm, &dd, &fd) != 0) return false;
    return from_fields(yy, mm, dd, h, mi, sec, frac, out);
  }
  return false;
}

bool parse_epoch(const std::string& token, const std::string& scale, double offset_s, UtcEpoch* out) {
  std::string s;
  for (char ch : scale)
    if (ch != ' ') s.push_back(static_cast<char>(std::toupper(static_cast<unsigned char>(ch))));
  UtcEpoch label;
  if (!parse_iso_utc(token, &label)) return false;
  if (s.empty() || s == "UTC") {
    *out = offset_s != 0.0 ? add_seconds(label, offset_s) : label;
    return true;
  }
  double shift = 0.0;
  if (s == "GPS") shift = 19.0;  // TAI = GPS + 19 s
  else if (s != "TAI") return false;
  // The calendar label is read again on TAI, then mapped to UTC.
  int y, mo, d, ihmsf[4];
  if (eraD2dtf("UTC", 9, label.jd1, label.jd2, &y, &mo, &d, ihmsf) < 0) return false;
  double t1, t2;
  if (eraDtf2d("TAI", y, mo, d, ihmsf[0], ihmsf[1], ihmsf[2] + ihmsf[3] * 1e-9, &t1, &t2) < 0) return false;
  t2 += (shift + offset_s) / 86400.0;
  double u1, u2;
  if (eraTaiutc(t1, t2, &u1, &u2) < 0) return false;
  const double base = std::floor(u1 + u2 - 0.5) + 0.5;
  out->jd1 = base;
  out->jd2 = (u1 - base) + u2;
  return true;
}

bool parse_meme_utc(const std::string& text, UtcEpoch* out) {
  // YYYYDDDHHMMSS.sss
  if (text.size() < 13) return false;
  for (int i = 0; i < 13; ++i)
    if (!std::isdigit(static_cast<unsigned char>(text[i]))) return false;
  const int y = std::stoi(text.substr(0, 4));
  const int doy = std::stoi(text.substr(4, 3));
  char iso[64];
  std::snprintf(iso, sizeof iso, "%04d-%03dT%s:%s:%s", y, doy, text.substr(7, 2).c_str(),
                text.substr(9, 2).c_str(), text.substr(11).c_str());
  return parse_iso_utc(iso, out);
}

std::string format_iso_utc(const UtcEpoch& t, int decimals) {
  int ihmsf[4];
  int y, mo, d;
  if (eraD2dtf("UTC", decimals, t.jd1, t.jd2, &y, &mo, &d, ihmsf) < 0) return "";
  char buf[64];
  if (decimals > 0) {
    char fmt[48];
    std::snprintf(fmt, sizeof fmt, "%%04d-%%02d-%%02dT%%02d:%%02d:%%02d.%%0%dd", decimals);
    std::snprintf(buf, sizeof buf, fmt, y, mo, d, ihmsf[0], ihmsf[1], ihmsf[2], ihmsf[3]);
  } else {
    std::snprintf(buf, sizeof buf, "%04d-%02d-%02dT%02d:%02d:%02d", y, mo, d, ihmsf[0], ihmsf[1],
                  ihmsf[2]);
  }
  return buf;
}

UtcEpoch utc_from_calendar(int year, int month, int day, int hour, int minute, double second) {
  UtcEpoch e;
  const int whole = static_cast<int>(std::floor(second));
  if (!from_fields(year, month, day, hour, minute, whole, second - whole, &e)) e = {0, 0};
  return e;
}

void utc_to_tt(const UtcEpoch& t, double* tt1, double* tt2) {
  double a1, a2;
  eraUtctai(t.jd1, t.jd2, &a1, &a2);
  eraTaitt(a1, a2, tt1, tt2);
}

double seconds_between(const UtcEpoch& a, const UtcEpoch& b) {
  double a1, a2, b1, b2;
  utc_to_tt(a, &a1, &a2);
  utc_to_tt(b, &b1, &b2);
  return ((b1 - a1) + (b2 - a2)) * 86400.0;
}

UtcEpoch add_seconds(const UtcEpoch& a, double seconds) {
  double t1, t2;
  utc_to_tt(a, &t1, &t2);
  // Keep the day part whole so the fraction carries the precision.
  double f = t2 + seconds / 86400.0;
  const double whole = std::floor(f);
  t1 += whole;
  f -= whole;
  double a1, a2, u1, u2;
  eraTttai(t1, f, &a1, &a2);
  eraTaiutc(a1, a2, &u1, &u2);
  // Normalize to (day boundary at .5, fraction) as eraDtf2d produces.
  const double base = std::floor(u1 + u2 - 0.5) + 0.5;
  UtcEpoch out;
  out.jd1 = base;
  out.jd2 = (u1 - base) + u2;
  return out;
}

Mat3 eme2000_to_gcrf() {
  double rb[3][3], rp[3][3], rbp[3][3];
  eraBp06(ERFA_DJ00, 0.0, rb, rp, rbp);  // rb: GCRF -> mean J2000
  Mat3 m{};
  for (int i = 0; i < 3; ++i)
    for (int j = 0; j < 3; ++j) m[i][j] = rb[j][i];
  return m;
}

Mat3 gcrf_to_teme(const UtcEpoch& t) {
  double tt1, tt2;
  utc_to_tt(t, &tt1, &tt2);
  double npb[3][3];
  eraPnm06a(tt1, tt2, npb);
  eraRz(eraEe06a(tt1, tt2), npb);
  Mat3 m{};
  for (int i = 0; i < 3; ++i)
    for (int j = 0; j < 3; ++j) m[i][j] = npb[i][j];
  return m;
}

Mat3 transpose(const Mat3& m) {
  Mat3 t{};
  for (int i = 0; i < 3; ++i)
    for (int j = 0; j < 3; ++j) t[i][j] = m[j][i];
  return t;
}

std::array<double, 3> rotate(const Mat3& m, const double v[3]) {
  return {m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
          m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
          m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2]};
}

struct EarthOrientation::Impl {
  std::vector<uint8_t> bytes;  // the PRW record the rows point into
  std::vector<sdn::frames::eop::Row> rows;
};

EarthOrientation::EarthOrientation() : impl_(new Impl) {}
EarthOrientation::~EarthOrientation() { delete impl_; }
bool EarthOrientation::loaded() const { return !impl_->rows.empty(); }

std::string EarthOrientation::load(const uint8_t* prw, std::size_t size) {
  impl_->rows.clear();
  impl_->bytes.assign(prw, prw + size);
  const uint8_t* data = impl_->bytes.data();
  flatbuffers::Verifier verifier(data, size);
  if (!VerifySizePrefixedPRWBuffer(verifier)) return "earth_orientation is not a size-prefixed $PRW record";
  const PRW* root = GetSizePrefixedPRW(data);
  if (!root->EARTH_ORIENTATION()) return "earth_orientation requires EARTH_ORIENTATION";
  return sdn::frames::eop::addRows(root->EARTH_ORIENTATION()->ROWS(), impl_->rows);
}

bool EarthOrientation::itrf_to_gcrf(const UtcEpoch& t, const double r_itrf[3], const double v_itrf[3],
                                    double r_gcrf[3], double v_gcrf[3], std::string* error) const {
  auto midnight = [](const char* date, double mjd) {
    int y = 0, m = 0, d = 0, h = 0, mi = 0, n = 0;
    double sec = 0, jd0 = 0, day = 0;
    if (std::sscanf(date, "%d-%d-%dT%d:%d:%lf%n", &y, &m, &d, &h, &mi, &sec, &n) != 6) return false;
    return !h && !mi && !sec && eraCal2jd(y, m, d, &jd0, &day) == 0 && day == mjd;
  };
  sdn::frames::EarthOrientation e;
  const std::string reason = sdn::frames::eop::at(impl_->rows, t.jd1, t.jd2, &e, midnight);
  if (!reason.empty()) {
    if (error) *error = "invalid-earth-orientation: " + reason;
    return false;
  }
  double tt1, tt2, ut11, ut12;
  utc_to_tt(t, &tt1, &tt2);
  if (eraUtcut1(t.jd1, t.jd2, e.dut1, &ut11, &ut12) < 0) {
    if (error) *error = "invalid-earth-orientation: UT1";
    return false;
  }
  double x, y, rc2i[3][3], rpom[3][3], rc2t[3][3];
  eraXy06(tt1, tt2, &x, &y);
  const double s = eraS06(tt1, tt2, x, y);
  eraC2ixys(x + e.dX, y + e.dY, s, rc2i);
  eraPom00(e.xPole, e.yPole, eraSp00(tt1, tt2), rpom);
  eraC2tcio(rc2i, eraEra00(ut11, ut12), rpom, rc2t);
  // rc2t = W R C (W: polar motion, ITRS = W TIRS). TIRS position and inertial
  // velocity expressed in TIRS axes: W' r, W' v + omega x (W' r).
  double rt[3], vt[3];
  eraTrxp(rpom, const_cast<double*>(r_itrf), rt);
  eraTrxp(rpom, const_cast<double*>(v_itrf), vt);
  const double omega = 7.292115146706979e-5 * (1.0 - e.lengthOfDay / 86400.0);
  vt[0] += -omega * rt[1];
  vt[1] += omega * rt[0];
  // GCRF = (R C)' TIRS, with R C = W' rc2t.
  double wt[3][3], rc[3][3];
  eraTr(rpom, wt);
  eraRxr(wt, rc2t, rc);
  eraTrxp(rc, rt, r_gcrf);
  eraTrxp(rc, vt, v_gcrf);
  return true;
}

}  // namespace odhpop
