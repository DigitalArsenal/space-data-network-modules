// analysis/density-calibration: JB2008 thermospheric density at points, with
// an exospheric-temperature correction field, and the estimation of that
// field from observed densities: a public, simplified analogue of the
// Dynamic Calibration of the Atmosphere (DCA) inside the Air Force's HASDM
// (Storz et al. 2005, Adv. Space Res. 36(12), 2497-2505), which estimates
// global corrections to Jacchia's temperatures from calibration-satellite
// drag every few hours.
//
// Typed contracts 1.0: every method takes one SDS $DCL (Density Calibration)
// record on "request" and answers with one $DCL on its output port. The
// request names the model in ATMOSPHERE ($ATM: JB08, or NRLMSIS00E), carries
// the JB2008 drivers as $PRW PRWJB2008IndicesTable rows (JB2008_DRIVERS) or the
// NRLMSISE-00 daily space weather as $SPW rows (SPACE_WEATHER), the correction
// (CORRECTION), the settings (SETTINGS), and the points (POINTS), element-set
// histories ($OMM, OBJECTS) or states ($OEM ephemeris block, STATES) of the
// method. Times are Unix milliseconds (UTC) on the wire and UTC MJD inside:
// mjd = (ms + 40587 * 86400000) / 86400000, one rounding. No JSON anywhere.
//
// The density is propagator/ffm's JB2008 (lib/jb2008.h, Orekit 13.1's port,
// itself a port of Space Environment Technologies' Fortran), driven as ffm
// drives it: SOLFSMY values at 12 UT of each DATE interpolated linearly at
// the instant less JB2008's lags (1 day F10 and S10, 2 M10, 5 Y10), DSTDTC
// linear between hourly values; the Sun's and the point's Earth-fixed
// longitude and latitude. The correction dT(lat, h) is added to DSTDTC, so
// it adds to the local exospheric temperature exactly as JB2008's own
// geomagnetic term does; a constant dT is therefore the same model as ffm
// with every DTC value raised by dT.
//
// dT(lat, h) = sum over l = 0..L, m = 0..l of P_l^m(sin lat) (a_lm cos mh +
// b_lm sin mh), Schmidt semi-normalized, h the point's hour angle from the
// Sun (Earth-fixed longitude minus the Sun's; local solar time is 12 h + h).
// Coefficient order: (0,0), (1,0), (1,1)c, (1,1)s, (2,0), (2,1)c, (2,1)s,
// (2,2)c, (2,2)s, ...; a_00 is the global mean of dT.
//
// The Sun: ERFA's eraEpv00 (heliocentric Earth, BCRS axes) negated, rotated
// to Earth-fixed axes by the IAU 2006/2000A CIO-based celestial-to-
// intermediate matrix (held for an hour of TT) and the Earth rotation angle
// with UT1 = UTC and no polar motion. Its direction is within 0.01 deg of
// DE440's, i.e. 2.4 s of local solar time.
//
// NRLMSISE-00: `evaluate` and `drag_work` also take ATMOSPHERE NRLMSIS00E with
// SPACE_WEATHER ($SPW rows: DATE, F107_OBS, F107_OBS_CENTER81, AP_AVG), the real
// model through the public-domain Brodowski C port in third_party/nrlmsise00
// (gtd7d: total mass density with anomalous oxygen), driven as propagator/ffm
// drives it (src/cpp/src/prw_execution.cpp SpaceWeatherTable): at a UTC instant on
// day d, F10.7 is the observed flux of day d-1, F10.7a the 81-day centred mean of
// day d, Ap the daily Ap of day d (all switches 1: the daily-Ap form), local solar
// time = UT + longitude/15, the WGS84 geodetic point. No correction applies to it.
//
// Methods ($DCL in, $DCL out):
//   evaluate         density, its log-derivative in dT, dT and local solar time at each point.
//   calibrate        per time bin, the coefficients minimising the weighted sum of squared
//                    log-density residuals plus a Gaussian prior on each coefficient.
//   decay            the drag decay of element-set histories (the forward model).
//   calibrate_decay  node correction and ballistic coefficients from orbital decay.
//   energy           the Jacobi integral of the geopotential of states, and its gradient.
//   drag_work        drag power and work along states.
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <limits>
#include <map>
#include <string>
#include <vector>

#include "open_dca_common_mode.hpp"
#include "typedHostcall.hpp"
#include "DCL_generated.h"  // spacedatastandards.org lib/cpp/DCL/main_generated.h and the headers it includes, inlined by build.mjs

namespace {

namespace fb = ::flatbuffers;
using astro::jb2008::Inputs;
constexpr double kPi = 3.14159265358979323846;
constexpr double kDeg = kPi / 180.0;
constexpr double kNaN = std::numeric_limits<double>::quiet_NaN();

int fail(const char* code, const std::string& message) {
  plugin_set_error(code, message.c_str());
  return 1;
}
// The one $DCL request of a method; nullptr (and the reason) when it is absent or not a $DCL.
const DCL* dcl_request(std::string& error) {
  const plugin_input_frame_t* frame = nullptr;
  const uint32_t count = plugin_get_input_count();
  for (uint32_t i = 0; i < count; ++i) {
    const plugin_input_frame_t* f = plugin_get_input_frame(i);
    if (!f || !f->port_id || std::strcmp(f->port_id, "request") != 0) continue;
    if (frame) { error = "a method takes one $DCL frame on \"request\"; the surplus frames are refused."; return nullptr; }
    frame = f;
  }
  if (!frame || !frame->payload) { error = "request must be a $DCL (Density Calibration) record."; return nullptr; }
  fb::Verifier verifier(frame->payload, frame->payload_length);
  if (!VerifyDCLBuffer(verifier)) { error = "request must be a $DCL (Density Calibration) record."; return nullptr; }
  return GetDCL(frame->payload);
}
int emit(const char* port, fb::FlatBufferBuilder& b, fb::Offset<DCL> root) {
  FinishDCLBuffer(b, root);
  return plugin_push_output_ex(port, "DCL.fbs", DCLIdentifier(), PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, "DCL", 0, 0, b.GetBufferPointer(),
                               static_cast<uint32_t>(b.GetSize())) < 0
             ? 1
             : 0;
}
// Unix milliseconds (UTC) <-> UTC MJD. The MJD is the exact quotient rounded once.
double mjd_of_ms(int64_t ms) { return (double(ms) + 3506716800000.0) / 86400000.0; }
int64_t ms_of_mjd(double mjd) { return std::isfinite(mjd) ? int64_t(std::llround((mjd - 40587.0) * 86400000.0)) : 0; }
// An ISO 8601 UTC instant (YYYY-MM-DD[THH:MM:SS[.f]][Z]) as UTC MJD: the day's MJD plus (h 3600 + m 60 + s) / 86400.
bool mjd_of_iso(const fb::String* text, double& mjd) {
  if (!text) return false;
  int y = 0, mo = 0, d = 0, h = 0, mi = 0;
  char sec[40] = {0};
  const int n = std::sscanf(text->c_str(), "%d-%d-%d%*[T ]%d:%d:%39[0-9.]", &y, &mo, &d, &h, &mi, sec);
  if (n != 3 && n != 6) return false;
  double jd0 = 0, mjd0 = 0;
  if (eraCal2jd(y, mo, d, &jd0, &mjd0) != 0) return false;
  if (n == 3) { mjd = mjd0; return true; }
  char* end = nullptr;
  const double s = std::strtod(sec, &end);
  if (end == sec || h < 0 || h > 23 || mi < 0 || mi > 59 || !(s >= 0 && s < 61)) return false;
  mjd = mjd0 + (h * 3600.0 + mi * 60.0 + s) / 86400.0;
  return true;
}
template <typename T>
size_t size_of(const fb::Vector<T>* v) { return v ? v->size() : 0; }
fb::Offset<fb::Vector<double>> doubles(fb::FlatBufferBuilder& b, const std::vector<double>& v) { return b.CreateVector(v); }
fb::Offset<fb::Vector<int64_t>> times(fb::FlatBufferBuilder& b, const std::vector<double>& mjd) {
  std::vector<int64_t> ms(mjd.size());
  for (size_t i = 0; i < mjd.size(); ++i) ms[i] = ms_of_mjd(mjd[i]);
  return b.CreateVector(ms);
}
fb::Offset<fb::Vector<uint32_t>> indices(fb::FlatBufferBuilder& b, const std::vector<uint32_t>& v) { return b.CreateVector(v); }
bool finite(double x) { return std::isfinite(x); }
bool positive(double x) { return std::isfinite(x) && x > 0; }

// ── JB2008 drivers, read as propagator/ffm's JB2008IndicesTable reads PRW
// JB2008_INDICES rows (src/cpp/src/prw_execution.cpp) ──
class Jb2008Table {
 public:
  struct Day { double f10, f10B, s10, s10B, m10, m10B, y10, y10B; };
  std::vector<Day> days;
  std::vector<double> dtc;
  long firstMjd = 0;
  std::string add(const PRWJB2008IndicesTable* table) {
    const auto* rows = table ? table->ROWS() : nullptr;
    if (!rows || rows->size() == 0) return "JB2008_DRIVERS (the jb2008 driver rows) must hold at least one row.";
    for (const PRWJB2008Indices* row : *rows) {
      int y = 0, m = 0, d = 0;
      double jd0 = 0, mjd = 0;
      const std::string date = row->DATE() ? row->DATE()->str() : std::string();
      if (std::sscanf(date.c_str(), "%d-%d-%d", &y, &m, &d) != 3 || eraCal2jd(y, m, d, &jd0, &mjd) != 0)
        return "JB2008 DATE must be an ISO 8601 calendar date.";
      if (days.empty()) firstMjd = long(mjd);
      else if (long(mjd) != firstMjd + long(days.size())) return "JB2008 rows must be consecutive days.";
      const Day v{row->F10(), row->F10_CENTRED_81(), row->S10(), row->S10_CENTRED_81(),
                  row->M10(), row->M10_CENTRED_81(), row->Y10(), row->Y10_CENTRED_81()};
      for (const double x : {v.f10, v.f10B, v.s10, v.s10B, v.m10, v.m10B, v.y10, v.y10B})
        if (!positive(x)) return "JB2008 solar indices must be positive and finite (" + date + ").";
      const auto* hourly = row->DTC_HOURLY_K();
      if (!hourly || hourly->size() != 24) return "JB2008 DTC_HOURLY_K needs 24 hourly values (" + date + ").";
      for (const double x : *hourly) {
        if (!finite(x)) return "JB2008 DTC values must be finite.";
        dtc.push_back(x);
      }
      days.push_back(v);
    }
    return "";
  }
  // Inputs at a UTC MJD; false outside the rows.
  bool at(double mjd, Inputs& out) const {
    const auto sol = [&](double lag, double Day::*member, double& value) {
      const double x = mjd - lag - (double(firstMjd) + 0.5);
      const long k = long(std::ceil(x)) - 1;
      if (k < 0 || k + 1 >= long(days.size())) return false;
      const double w = x - double(k);
      value = days[k].*member * (1 - w) + days[k + 1].*member * w;
      return true;
    };
    const double h = (mjd - double(firstMjd)) * 24.0;
    const long k = long(std::ceil(h)) - 1;
    if (k < 0 || k + 1 >= long(dtc.size())) return false;
    const double w = h - double(k);
    out.dstdtc = dtc[k] * (1 - w) + dtc[k + 1] * w;
    return sol(1, &Day::f10, out.f10) && sol(1, &Day::f10B, out.f10B) && sol(1, &Day::s10, out.s10) &&
           sol(1, &Day::s10B, out.s10B) && sol(2, &Day::m10, out.xm10) && sol(2, &Day::m10B, out.xm10B) &&
           sol(5, &Day::y10, out.y10) && sol(5, &Day::y10B, out.y10B);
  }
};

// ── NRLMSISE-00 drivers, read as propagator/ffm's SpaceWeatherTable reads $SPW rows ──
class Nrlmsise00Table {
 public:
  struct Day { double f107Obs, f107ObsCentred81, apDaily; };
  std::map<long, Day> days;  // by MJD (UTC)
  std::string add(const fb::Vector<fb::Offset<SPW>>* rows) {
    if (!rows || rows->size() == 0) return "SPACE_WEATHER (the nrlmsise00 driver rows) must hold at least one $SPW row.";
    long previous = 0;
    bool first = true;
    for (const SPW* row : *rows) {
      int y = 0, m = 0, d = 0;
      double jd0 = 0, mjd = 0;
      const std::string date = row->DATE() ? row->DATE()->str() : std::string();
      if (std::sscanf(date.c_str(), "%d-%d-%d", &y, &m, &d) != 3 || eraCal2jd(y, m, d, &jd0, &mjd) != 0)
        return "NRLMSISE-00 DATE must be an ISO 8601 calendar date.";
      const long day = long(mjd);
      if (!first && day <= previous) return "NRLMSISE-00 rows must have strictly increasing DATE.";
      first = false;
      previous = day;
      const Day v{double(row->F107_OBS()), double(row->F107_OBS_CENTER81()), double(row->AP_AVG())};
      if (!positive(v.f107Obs) || !positive(v.f107ObsCentred81) || !finite(v.apDaily) || v.apDaily < 0)
        return "NRLMSISE-00 F10.7 must be positive and Ap nonnegative (" + date + ").";
      days[day] = v;
    }
    return "";
  }
  // The model inputs at a UTC MJD on day d: F10.7 of day d-1, F10.7a and Ap of day d; false if a needed day is missing.
  bool at(double mjd, double& f107, double& f107a, double& ap) const {
    const long day = long(std::floor(mjd));
    const auto today = days.find(day), yesterday = days.find(day - 1);
    if (today == days.end() || yesterday == days.end()) return false;
    f107 = yesterday->second.f107Obs;
    f107a = today->second.f107ObsCentred81;
    ap = today->second.apDaily;
    return true;
  }
};

// The model of a request: JB2008 (ATMOSPHERE absent or JB08) or NRLMSISE-00 (NRLMSIS00E); "" or the reason.
std::string atmosphere_of(const DCL* request, bool& msis) {
  msis = false;
  const ATM* atm = request->ATMOSPHERE();
  if (!atm || atm->MODEL() == AtmosphericModelFamily::JB08) return "";
  if (atm->MODEL() == AtmosphericModelFamily::NRLMSIS00E) { msis = true; return ""; }
  return "ATMOSPHERE (the atmosphere model) must be JB08 or NRLMSIS00E.";
}
fb::Offset<ATM> atmosphere_record(fb::FlatBufferBuilder& b, bool msis) {
  return CreateATM(b, msis ? AtmosphericModelFamily::NRLMSIS00E : AtmosphericModelFamily::JB08, msis ? 2000 : 2008);
}

// The mass density (kg/m^3) of NRLMSISE-00 at a geodetic point and a UTC MJD, with the inputs of Nrlmsise00Table::at and
// ffm's switches (0 for the output units, 1 for every variation: the daily-Ap form).
double msis_density(double mjd, double latRad, double lonRad, double altM, double f107, double f107a, double ap, double* lstHours = nullptr) {
  int year = 0, month = 0, dayOfMonth = 0;
  double fraction = 0;
  eraJd2cal(2400000.5, mjd, &year, &month, &dayOfMonth, &fraction);
  double jan1 = 0, mjdJan1 = 0;
  eraCal2jd(year, 1, 1, &jan1, &mjdJan1);
  const int doy = int(std::floor(mjd - mjdJan1)) + 1;
  const double sec = (mjd - std::floor(mjd)) * 86400.0;
  const double lonDeg = lonRad / kDeg;
  double lst = std::fmod(sec / 3600.0 + lonDeg / 15.0, 24.0);
  if (lst < 0.0) lst += 24.0;
  if (lstHours) *lstHours = lst;
  nrlmsise00::nrlmsise_input in;
  nrlmsise00::nrlmsise_flags flags;
  nrlmsise00::nrlmsise_output out;
  std::memset(&in, 0, sizeof(in));
  std::memset(&flags, 0, sizeof(flags));
  std::memset(&out, 0, sizeof(out));
  flags.switches[0] = 0;
  for (int i = 1; i < 24; ++i) flags.switches[i] = 1;
  in.year = year;  // ignored by the model
  in.doy = doy;
  in.sec = sec;
  in.alt = altM / 1000.0;
  in.g_lat = latRad / kDeg;
  in.g_long = lonDeg;
  in.lst = lst;
  in.f107A = f107a;
  in.f107 = f107;
  in.ap = ap;
  in.ap_a = nullptr;
  nrlmsise00::gtd7d(&in, &flags, &out);
  return out.d[5] * 1000.0;  // g/cm^3 -> kg/m^3 (total mass density with anomalous oxygen)
}

// ── The Sun in Earth-fixed axes ──
class SunEarthFixed {
 public:
  // Earth-fixed longitude and latitude (rad) of the Sun's direction at a UTC MJD.
  void at(double mjdUtc, double& lon, double& lat) {
    double tai1 = 0, tai2 = 0, tt1 = 0, tt2 = 0;
    eraUtctai(2400000.5, mjdUtc, &tai1, &tai2);
    eraTaitt(tai1, tai2, &tt1, &tt2);
    const double ttHour = std::floor(((tt1 - 2400000.5) + tt2) * 24.0);
    if (ttHour != cachedHour) {
      eraC2i06a(2400000.5, ttHour / 24.0, rc2i);
      cachedHour = ttHour;
    }
    double pvh[2][3], pvb[2][3];
    eraEpv00(tt1, tt2, pvh, pvb);
    double sun[3] = {-pvh[0][0], -pvh[0][1], -pvh[0][2]};
    double cirs[3];
    eraRxp(rc2i, sun, cirs);
    const double era = eraEra00(2400000.5, mjdUtc);
    const double c = std::cos(era), s = std::sin(era);
    const double x = c * cirs[0] + s * cirs[1], y = -s * cirs[0] + c * cirs[1], z = cirs[2];
    lon = std::atan2(y, x);
    lat = std::atan2(z, std::hypot(x, y));
  }

 private:
  double cachedHour = std::numeric_limits<double>::quiet_NaN();
  double rc2i[3][3] = {};
};

// ── Correction basis ──
int basis_size(int degree) { return (degree + 1) * (degree + 1); }
// Schmidt semi-normalized P_l^m(sin lat) times cos/sin(m h), in coefficient order.
void basis(int degree, double lat, double h, double* y) {
  const double x = std::sin(lat), c = std::cos(lat);
  double P[9][9] = {};
  P[0][0] = 1.0;
  for (int m = 1; m <= degree; ++m) P[m][m] = (2 * m - 1) * c * P[m - 1][m - 1];
  for (int m = 0; m < degree; ++m) P[m + 1][m] = (2 * m + 1) * x * P[m][m];
  for (int m = 0; m <= degree; ++m)
    for (int l = m + 2; l <= degree; ++l) P[l][m] = ((2 * l - 1) * x * P[l - 1][m] - (l + m - 1) * P[l - 2][m]) / (l - m);
  int k = 0;
  for (int l = 0; l <= degree; ++l) {
    for (int m = 0; m <= l; ++m) {
      double norm = 1.0;
      if (m > 0) {
        double ratio = 1.0;  // (l-m)! / (l+m)!
        for (int i = l - m + 1; i <= l + m; ++i) ratio /= i;
        norm = std::sqrt(2.0 * ratio);
      }
      const double p = norm * P[l][m];
      if (m == 0) {
        y[k++] = p;
      } else {
        y[k++] = p * std::cos(m * h);
        y[k++] = p * std::sin(m * h);
      }
    }
  }
}

// One point ready for the model: the time, the Sun's and the point's
// Earth-fixed angles (rad), the altitude (m) and the drivers.
struct Point {
  double mjd = 0, sunLon = 0, sunLat = 0, lon = 0, lat = 0, altM = 0;
  Inputs in{};
  double f107 = 0, f107a = 0, ap = 0;  // NRLMSISE-00 drivers (atmosphere NRLMSISE00)
  bool msis = false;
  bool ok = false;
};
double rho_at(const Point& p, double dT) {
  Inputs in = p.in;
  in.dstdtc += dT;
  return astro::jb2008::density(p.mjd, p.sunLon, p.sunLat, p.lon, p.lat, p.altM, in);
}
double hour_angle(const Point& p) { return std::remainder(p.lon - p.sunLon, 2 * kPi); }

// Points from POINTS {TIME_MS, LATITUDE_DEG, LONGITUDE_DEG, ALTITUDE_KM} with
// the drivers of the request's model (JB2008_DRIVERS, or SPACE_WEATHER for
// NRLMSIS00E), or, when POINTS carries MODEL_DRIVERS, the arguments of Space
// Environment Technologies' JB2008 subroutine at each point: the time, the
// Sun's right ascension and declination, the point's longitude and latitude
// (deg, taken as given), its altitude and nine driver values [F10, F10B, S10,
// S10B, M10, M10B, Y10, Y10B, DSTDTC].
std::string load_points(const DCL* request, std::vector<Point>& points) {
  const dclPoints* pts = request->POINTS();
  if (!pts) return "POINTS {TIME_MS, LATITUDE_DEG, LONGITUDE_DEG, ALTITUDE_KM} is required.";
  const size_t n = size_of(pts->TIME_MS());
  if (size_of(pts->LATITUDE_DEG()) != n || size_of(pts->LONGITUDE_DEG()) != n || size_of(pts->ALTITUDE_KM()) != n)
    return "POINTS LATITUDE_DEG, LONGITUDE_DEG and ALTITUDE_KM must have one value per point (TIME_MS).";
  if (size_of(pts->MODEL_DRIVERS()) != 0) {
    if (size_of(pts->MODEL_DRIVERS()) != 9 * n || size_of(pts->SUN_RIGHT_ASCENSION_DEG()) != n || size_of(pts->SUN_DECLINATION_DEG()) != n)
      return "POINTS MODEL_DRIVERS need nine values per point and SUN_RIGHT_ASCENSION_DEG and SUN_DECLINATION_DEG one.";
    const auto* v = pts->MODEL_DRIVERS();
    for (size_t i = 0; i < n; ++i) {
      Point p;
      p.mjd = mjd_of_ms(pts->TIME_MS()->Get(i));
      p.sunLon = pts->SUN_RIGHT_ASCENSION_DEG()->Get(i) * kDeg;
      p.sunLat = pts->SUN_DECLINATION_DEG()->Get(i) * kDeg;
      p.lon = pts->LONGITUDE_DEG()->Get(i) * kDeg;
      p.lat = pts->LATITUDE_DEG()->Get(i) * kDeg;
      p.altM = pts->ALTITUDE_KM()->Get(i) * 1000.0;
      const size_t k = 9 * i;
      p.in = Inputs{v->Get(k), v->Get(k + 1), v->Get(k + 2), v->Get(k + 3), v->Get(k + 4), v->Get(k + 5), v->Get(k + 6), v->Get(k + 7), v->Get(k + 8)};
      p.ok = true;
      points.push_back(p);
    }
    return "";
  }
  bool msis = false;
  std::string e = atmosphere_of(request, msis);
  if (!e.empty()) return e;
  Jb2008Table table;
  Nrlmsise00Table msisTable;
  e = msis ? msisTable.add(request->SPACE_WEATHER()) : table.add(request->JB2008_DRIVERS());
  if (!e.empty()) return e;
  SunEarthFixed sun;
  points.resize(n);
  for (size_t i = 0; i < n; ++i) {
    Point& p = points[i];
    p.mjd = mjd_of_ms(pts->TIME_MS()->Get(i));
    p.lat = pts->LATITUDE_DEG()->Get(i) * kDeg;
    // JB2008 expects longitudes in [-pi, pi], as ffm's geodetic conversion gives them.
    p.lon = std::remainder(pts->LONGITUDE_DEG()->Get(i) * kDeg, 2 * kPi);
    p.altM = pts->ALTITUDE_KM()->Get(i) * 1000.0;
    if (msis) {
      // NRLMSISE-00 is defined to 1000 km; a point outside, or on a day the rows do not cover, is refused and never guessed.
      if (!finite(p.mjd) || !finite(p.lat) || !finite(p.lon) || !(p.altM >= 90e3 && p.altM <= 1000e3)) continue;
      if (!msisTable.at(p.mjd, p.f107, p.f107a, p.ap)) continue;
      p.msis = true;
      p.ok = true;
      continue;
    }
    if (!finite(p.mjd) || !finite(p.lat) || !finite(p.lon) || !(p.altM >= 90e3 && p.altM <= 2500e3)) continue;
    if (!table.at(p.mjd, p.in)) continue;
    sun.at(p.mjd, p.sunLon, p.sunLat);
    p.ok = true;
  }
  return "";
}

// A correction in time nodes (FORM Nodes: NODE_TIMES_MS, NODE_ALTITUDES_KM,
// NODE_VALUES_K): dT(t, h) = sum_j sum_a values[j][a] phi_j(t) w_a(h), phi_j
// the linear interpolant in time between nodes (the first and last values
// held outside them) and w_a the linear interpolant in altitude between the
// altitude nodes, extrapolated linearly up to 100 km beyond the outer nodes
// and held beyond that; no altitude nodes is one global value per node.
// calibrate_decay estimates it.
struct NodeCorrection {
  std::vector<double> t, alt, v;  // node MJDs, altitude nodes (km), values node-major [j * P + a]
  int P() const { return alt.empty() ? 1 : int(alt.size()); }
  int M() const { return int(t.size()); }
  std::string load(const dclCorrection* c) {
    t.clear(); alt.clear(); v.clear();
    if (size_of(c->NODE_TIMES_MS()) == 0) return "CORRECTION NODE_TIMES_MS must hold at least one node.";
    for (const int64_t ms : *c->NODE_TIMES_MS()) t.push_back(mjd_of_ms(ms));
    for (size_t i = 1; i < t.size(); ++i) if (!(t[i] > t[i - 1])) return "CORRECTION NODE_TIMES_MS must increase.";
    if (c->NODE_ALTITUDES_KM()) for (const double x : *c->NODE_ALTITUDES_KM()) alt.push_back(x);
    if (alt.size() == 1) return "CORRECTION NODE_ALTITUDES_KM needs none (global) or at least two altitudes.";
    for (size_t i = 1; i < alt.size(); ++i) if (!(alt[i] > alt[i - 1])) return "CORRECTION NODE_ALTITUDES_KM must increase.";
    if (size_of(c->NODE_VALUES_K()) != t.size() * size_t(P()))
      return "CORRECTION NODE_VALUES_K needs one value per time node and altitude node (one per time node when global).";
    for (const double x : *c->NODE_VALUES_K()) { if (!finite(x)) return "CORRECTION values must be finite numbers."; v.push_back(x); }
    return "";
  }
  void timeWeight(double mjd, int& j0, double& w) const {
    if (t.size() == 1 || mjd <= t.front()) { j0 = 0; w = 0; return; }
    if (mjd >= t.back()) { j0 = M() - 2; w = 1; return; }
    j0 = int(std::upper_bound(t.begin(), t.end(), mjd) - t.begin()) - 1;
    w = (mjd - t[j0]) / (t[j0 + 1] - t[j0]);
  }
  void altitudeWeight(double hKm, int& a0, double& w) const {
    if (P() == 1) { a0 = 0; w = 0; return; }
    const double h = std::max(alt.front() - 100.0, std::min(alt.back() + 100.0, hKm));
    a0 = std::max(0, std::min(P() - 2, int(std::upper_bound(alt.begin(), alt.end(), h) - alt.begin()) - 1));
    w = (h - alt[a0]) / (alt[a0 + 1] - alt[a0]);
  }
  double value(int j, int a) const { return v[size_t(j) * P() + a]; }
  // dT at (t, h) and, when asked, its weights: up to four (index, weight) pairs.
  double at(double mjd, double hKm, int* index = nullptr, double* weight = nullptr) const {
    int j0, a0;
    double wt, wa;
    timeWeight(mjd, j0, wt);
    altitudeWeight(hKm, a0, wa);
    const int jn = M() == 1 ? 0 : j0 + 1, an = P() == 1 ? 0 : a0 + 1;
    const int idx[4] = {j0 * P() + a0, j0 * P() + an, jn * P() + a0, jn * P() + an};
    const double wgt[4] = {(1 - wt) * (1 - wa), (1 - wt) * wa, wt * (1 - wa), wt * wa};
    double dT = 0;
    for (int k = 0; k < 4; ++k) {
      dT += wgt[k] * v[idx[k]];
      if (index) { index[k] = idx[k]; weight[k] = wgt[k]; }
    }
    return dT;
  }
  fb::Offset<dclCorrection> record(fb::FlatBufferBuilder& b, const std::vector<double>* sigmas) const {
    const auto tt = times(b, t);
    const auto aa = doubles(b, alt), vv = doubles(b, v);
    const auto ss = sigmas ? doubles(b, *sigmas) : fb::Offset<fb::Vector<double>>();
    dclCorrectionBuilder c(b);
    c.add_FORM(dclCorrectionForm::Nodes);
    c.add_NODE_TIMES_MS(tt);
    c.add_NODE_ALTITUDES_KM(aa);
    c.add_NODE_VALUES_K(vv);
    if (sigmas) c.add_NODE_SIGMAS_K(ss);
    return c.Finish();
  }
};

// A correction: FORM None (dT = 0), Nodes (above), or Harmonic: DEGREE and
// SEGMENTS [{FROM_MS, TO_MS, COEFFICIENTS_K}], the segment holding the instant
// (from <= t < to) applying, none meaning dT = 0. A segment with no
// coefficients (a bin calibrate could not fit) applies nowhere.
struct Correction {
  int degree = 0;
  bool nodal = false, present = false;
  NodeCorrection nodes;
  struct Segment { double from, to; std::vector<double> c; };
  std::vector<Segment> segments;
  std::string load(const dclCorrection* j) {
    if (!j || j->FORM() == dclCorrectionForm::None) return "";
    present = true;
    if (j->FORM() == dclCorrectionForm::Nodes) {
      nodal = true;
      return nodes.load(j);
    }
    if (j->FORM() != dclCorrectionForm::Harmonic) return "CORRECTION FORM must be None, Harmonic or Nodes.";
    degree = j->DEGREE();
    if (degree < 0 || degree > 8) return "CORRECTION DEGREE must be 0-8.";
    if (j->SEGMENTS())
      for (const dclHarmonicSegment* s : *j->SEGMENTS()) {
        Segment g{mjd_of_ms(s->FROM_MS()), mjd_of_ms(s->TO_MS()), {}};
        if (!(g.to > g.from)) return "CORRECTION segments need TO_MS > FROM_MS.";
        if (size_of(s->COEFFICIENTS_K()) == 0) continue;
        if (int(s->COEFFICIENTS_K()->size()) != basis_size(degree)) return "each CORRECTION segment needs (DEGREE+1)^2 coefficients.";
        for (const double x : *s->COEFFICIENTS_K()) g.c.push_back(x);
        segments.push_back(g);
      }
    std::sort(segments.begin(), segments.end(), [](const Segment& a, const Segment& b) { return a.from < b.from; });
    for (size_t i = 1; i < segments.size(); ++i)
      if (segments[i].from < segments[i - 1].to) return "CORRECTION segments must not overlap.";
    return "";
  }
  double at(const Point& p) const {
    if (nodal) return nodes.at(p.mjd, p.altM / 1000.0);
    auto it = std::upper_bound(segments.begin(), segments.end(), p.mjd, [](double t, const Segment& s) { return t < s.from; });
    if (it == segments.begin()) return 0.0;
    --it;
    if (!(p.mjd < it->to)) return 0.0;
    double y[81];
    basis(degree, p.lat, hour_angle(p), y);
    double dT = 0;
    for (int k = 0; k < basis_size(degree); ++k) dT += it->c[k] * y[k];
    return dT;
  }
  // The correction as applied, for the answer; a null offset when there is none.
  fb::Offset<dclCorrection> record(fb::FlatBufferBuilder& b) const {
    if (!present) return 0;
    if (nodal) return nodes.record(b, nullptr);
    std::vector<fb::Offset<dclHarmonicSegment>> segs;
    for (const Segment& s : segments) {
      const auto c = doubles(b, s.c);
      dclHarmonicSegmentBuilder g(b);
      g.add_FROM_MS(ms_of_mjd(s.from));
      g.add_TO_MS(ms_of_mjd(s.to));
      g.add_COEFFICIENTS_K(c);
      segs.push_back(g.Finish());
    }
    const auto sv = b.CreateVector(segs);
    dclCorrectionBuilder c(b);
    c.add_FORM(dclCorrectionForm::Harmonic);
    c.add_DEGREE(uint8_t(degree));
    c.add_SEGMENTS(sv);
    return c.Finish();
  }
};

// Solves A x = b in place (A symmetric positive definite, n x n); false if not.
bool cholesky_solve(std::vector<double>& A, std::vector<double>& b, int n, std::vector<double>* inverse) {
  for (int j = 0; j < n; ++j) {
    double d = A[j * n + j];
    for (int k = 0; k < j; ++k) d -= A[j * n + k] * A[j * n + k];
    if (!(d > 0)) return false;
    A[j * n + j] = std::sqrt(d);
    for (int i = j + 1; i < n; ++i) {
      double s = A[i * n + j];
      for (int k = 0; k < j; ++k) s -= A[i * n + k] * A[j * n + k];
      A[i * n + j] = s / A[j * n + j];
    }
  }
  const auto solve = [&](std::vector<double>& v) {
    for (int i = 0; i < n; ++i) { for (int k = 0; k < i; ++k) v[i] -= A[i * n + k] * v[k]; v[i] /= A[i * n + i]; }
    for (int i = n - 1; i >= 0; --i) { for (int k = i + 1; k < n; ++k) v[i] -= A[k * n + i] * v[k]; v[i] /= A[i * n + i]; }
  };
  solve(b);
  if (inverse) {
    inverse->assign(n * n, 0.0);
    for (int c = 0; c < n; ++c) {
      std::vector<double> e(n, 0.0);
      e[c] = 1.0;
      solve(e);
      for (int r = 0; r < n; ++r) (*inverse)[r * n + c] = e[r];
    }
  }
  return true;
}

double median_abs(std::vector<double> v) {
  if (v.empty()) return 0;
  for (double& x : v) x = std::abs(x);
  std::nth_element(v.begin(), v.begin() + v.size() / 2, v.end());
  return v[v.size() / 2];
}
double median_of(std::vector<double> v) {
  if (v.empty()) return 0;
  std::nth_element(v.begin(), v.begin() + v.size() / 2, v.end());
  return v[v.size() / 2];
}

// ── Orbit decay from element sets ──
// Each element set is propagated by SGP4 (the SGP4/SDP4 base
// foundation/sgp4-str3: WGS-72, improved mode) from its epoch to the next
// set's epoch. Its mean semi-major axis is SGP4's own recovered (Brouwer,
// un-Kozai'd) a''. Drag changes
// the semi-major axis at
//   da/dt = -(a^2 / mu) B rho |v_r| (v . v_r),   v_r = v - omega_E x r
// (Gauss's equation for the drag acceleration -1/2 B rho |v_r| v_r, B =
// Cd A/m, the atmosphere co-rotating with the Earth), which is integrated
// along the set's trajectory by the trapezoid rule. Over whole revolutions
// this is the drag change in mean semi-major axis that the next set observes.
// rho is JB2008 with the correction, at the trajectory's geodetic latitude,
// longitude and altitude: TEME turned Earth-fixed by GMST (IAU 1982, UT1 =
// UTC; no polar motion), as SGP4's TEME is defined, then WGS84.
constexpr double kMu = 3.986004418e14;       // m^3/s^2
constexpr double kOmegaEarth = 7.292115e-5;  // rad/s
constexpr double kSgp4EpochMjd = 33281.0;    // SGP4 epochs count days from 1949 December 31 0h UT

struct ElementSet {
  double mjd = 0, aKm = 0, ecc = 0, perigeeKm = 0, bstar = 0;
  sdnap::Sat sat{};
};
std::string load_set(const OMM* s, ElementSet& out) {
  const auto num = [&](double value, double& x) {
    x = value;
    return finite(x);
  };
  double n = 0, e = 0, inc = 0, raan = 0, argp = 0, ma = 0;
  if (!mjd_of_iso(s->EPOCH(), out.mjd) || !finite(out.mjd) || !num(s->MEAN_MOTION(), n) || !num(s->ECCENTRICITY(), e) ||
      !num(s->INCLINATION(), inc) || !num(s->RA_OF_ASC_NODE(), raan) || !num(s->ARG_OF_PERICENTER(), argp) || !num(s->MEAN_ANOMALY(), ma) ||
      !num(s->BSTAR(), out.bstar))
    return "fields";
  if (!(n > 0) || !(e >= 0 && e < 1)) return "mean-motion-or-eccentricity";
  // The epoch as one Julian date, as SGP4 counts it (days from 1949 December 31 0h UT, + JD 2433281.5).
  sdnap::Elements el{};
  el.epoch_jd_whole = (out.mjd - kSgp4EpochMjd) + sdnap::kJd1950;
  el.xno = n * 2 * kPi / 1440.0;
  el.eo = e;
  el.xincl = inc * kDeg;
  el.xnodeo = raan * kDeg;
  el.omegao = argp * kDeg;
  el.xmo = ma * kDeg;
  el.bstar = out.bstar;
  const sdnap::Gravity wgs72 = sdnap::gravity_wgs72();
  double r0[3], v0[3];
  if (sdnap::sat_init(el, wgs72, out.sat, sdnap::Sgp4Mode::kImproved) != sdnap::kPropOk ||
      sdnap::sat_propagate(out.sat, nullptr, 0.0, r0, v0) != sdnap::kPropOk)
    return "sgp4-init";
  if (out.sat.ideep) return "deep-space";
  out.aKm = out.sat.aodp * wgs72.radius_km;
  out.ecc = e;
  out.perigeeKm = out.aKm * (1 - e) - wgs72.radius_km;
  return "";
}

// The Sun's CIRS direction at every TT hour of a span (ERFA, as
// SunEarthFixed), interpolated linearly in time and turned Earth-fixed by the
// Earth rotation angle (UT1 = UTC): within 1e-6 rad of SunEarthFixed.
class SunTable {
 public:
  void build(double fromMjd, double toMjd) {
    first = std::floor(tt_mjd(fromMjd) * 24.0) - 1;
    const long n = long(std::ceil(tt_mjd(toMjd) * 24.0) + 2 - first);
    s.assign(size_t(std::max(2L, n)), {0, 0, 0});
    for (size_t k = 0; k < s.size(); ++k) {
      const double tt = (first + double(k)) / 24.0;
      double pvh[2][3], pvb[2][3], rc2i[3][3];
      eraEpv00(2400000.5, tt, pvh, pvb);
      eraC2i06a(2400000.5, tt, rc2i);
      double sun[3] = {-pvh[0][0], -pvh[0][1], -pvh[0][2]};
      eraRxp(rc2i, sun, s[k].data());
    }
  }
  bool at(double mjdUtc, double& lon, double& lat) const {
    const double h = tt_mjd(mjdUtc) * 24.0 - first;
    const long k = long(std::floor(h));
    if (k < 0 || k + 1 >= long(s.size())) return false;
    const double w = h - double(k);
    double c[3];
    for (int i = 0; i < 3; ++i) c[i] = s[k][i] * (1 - w) + s[k + 1][i] * w;
    const double era = eraEra00(2400000.5, mjdUtc);
    const double ce = std::cos(era), se = std::sin(era);
    const double x = ce * c[0] + se * c[1], y = -se * c[0] + ce * c[1], z = c[2];
    lon = std::atan2(y, x);
    lat = std::atan2(z, std::hypot(x, y));
    return true;
  }

 private:
  static double tt_mjd(double mjdUtc) {
    double a1 = 0, a2 = 0, t1 = 0, t2 = 0;
    eraUtctai(2400000.5, mjdUtc, &a1, &a2);
    eraTaitt(a1, a2, &t1, &t2);
    return (t1 - 2400000.5) + t2;
  }
  double first = 0;
  std::vector<std::array<double, 3>> s;
};

// A point of a set's trajectory: the JB2008 point and the decay weight q =
// (a^2 / mu) |v_r| (v . v_r) in m^2/s, so that da/dt = -B rho q. rv, when
// given, receives the TEME state (km, km/s). Returns kPointFailed (SGP4
// refused, below 90 km, or outside the drivers), kPointOk, or kPointAbove:
// above 2500 km, JB2008's ceiling here, where the point adds no drag.
constexpr int kPointFailed = 0, kPointOk = 1, kPointAbove = 2;
int trajectory_point(ElementSet& set, double mjd, const Jb2008Table& table, const SunTable& sun, Point& p, double& q, double* rv) {
  double r[3], v[3];
  if (sdnap::sat_propagate(set.sat, nullptr, (mjd - set.mjd) * 1440.0, r, v) != sdnap::kPropOk) return kPointFailed;
  const double rm[3] = {r[0] * 1e3, r[1] * 1e3, r[2] * 1e3}, vm[3] = {v[0] * 1e3, v[1] * 1e3, v[2] * 1e3};
  const double rr = std::sqrt(rm[0] * rm[0] + rm[1] * rm[1] + rm[2] * rm[2]), vv = vm[0] * vm[0] + vm[1] * vm[1] + vm[2] * vm[2];
  const double a = 1.0 / (2.0 / rr - vv / kMu);
  const double vr[3] = {vm[0] + kOmegaEarth * rm[1], vm[1] - kOmegaEarth * rm[0], vm[2]};
  const double vrn = std::sqrt(vr[0] * vr[0] + vr[1] * vr[1] + vr[2] * vr[2]);
  q = a * a / kMu * vrn * (vm[0] * vr[0] + vm[1] * vr[1] + vm[2] * vr[2]);
  const double g = sdnap::str3::gmst_iau82(mjd + 2400000.5, 0.0);
  const double cg = std::cos(g), sg = std::sin(g);
  double ef[3] = {cg * rm[0] + sg * rm[1], -sg * rm[0] + cg * rm[1], rm[2]};
  double elong = 0, phi = 0, height = 0;
  if (eraGc2gd(1, ef, &elong, &phi, &height) != 0) return kPointFailed;
  p = Point{};
  p.mjd = mjd;
  p.lon = std::remainder(elong, 2 * kPi);
  p.lat = phi;
  p.altM = height;
  if (rv)
    for (int i = 0; i < 3; ++i) { rv[i] = r[i]; rv[3 + i] = v[i]; }
  if (p.altM > 2500e3) return kPointAbove;
  if (!(p.altM >= 90e3) || !table.at(mjd, p.in) || !sun.at(mjd, p.sunLon, p.sunLat)) return kPointFailed;
  p.ok = true;
  return kPointOk;
}

// One stretch of a set's trajectory, from its epoch (or a later instant) to
// the next set's epoch. D is the integral of -rho q dt (m per unit B), so
// that the drag change in mean semi-major axis is B * D; G is dD/d(value) over
// the correction nodes [j0, j1] x P.
struct Segment {
  int set = 0;
  double from = 0, to = 0, D = 0, altSum = 0, altCount = 0;
  int j0 = 0, j1 = -1;
  std::vector<double> G;
  bool ok = false;
};
// The trajectory points of decay's samples, column-major (SAMPLE_* of dclObject).
struct Samples {
  std::vector<double> mjd, teme, lat, lon, alt, rho, q;
};
bool integrate(ElementSet& set, Segment& sg, double stepS, const Jb2008Table& table, const SunTable& sun, const NodeCorrection& corr,
               bool gradient, Samples* samples) {
  const double span = (sg.to - sg.from) * 86400.0;
  const int n = std::max(1, int(std::ceil(span / stepS - 1e-9)));
  const double h = span / n;
  const int P = corr.P();
  sg.D = sg.altSum = sg.altCount = 0;
  sg.ok = false;
  if (gradient) {
    int ja = 0, jb = 0;
    double w = 0;
    corr.timeWeight(sg.from, ja, w);
    corr.timeWeight(sg.to, jb, w);
    sg.j0 = ja;
    sg.j1 = std::min(corr.M() - 1, jb + 1);
    sg.G.assign(size_t(sg.j1 - sg.j0 + 1) * P, 0.0);
  }
  Point p;
  for (int k = 0; k <= n; ++k) {
    const double mjd = sg.from + k * h / 86400.0;
    double q = 0, rv[6];
    const int status = trajectory_point(set, mjd, table, sun, p, q, samples ? rv : nullptr);
    if (status == kPointFailed) return false;
    if (status == kPointAbove) continue;
    int idx[4];
    double wgt[4];
    const double dT = corr.at(mjd, p.altM / 1000.0, idx, wgt);
    const double rho = rho_at(p, dT);
    if (!positive(rho)) return false;
    const double c = (k == 0 || k == n ? 0.5 : 1.0) * h;
    sg.D -= c * q * rho;
    sg.altSum += p.altM / 1000.0;
    sg.altCount += 1;
    if (gradient) {
      const double g = (std::log(rho_at(p, dT + 1.0)) - std::log(rho_at(p, dT - 1.0))) / 2.0;
      for (int m = 0; m < 4; ++m) {
        if (wgt[m] == 0) continue;
        const int j = idx[m] / P, a = idx[m] % P;
        sg.G[size_t(j - sg.j0) * P + a] -= c * q * rho * g * wgt[m];
      }
    }
    if (samples) {
      samples->mjd.push_back(mjd);
      samples->teme.insert(samples->teme.end(), rv, rv + 6);
      samples->lat.push_back(p.lat / kDeg);
      samples->lon.push_back(p.lon / kDeg);
      samples->alt.push_back(p.altM / 1000.0);
      samples->rho.push_back(rho);
      samples->q.push_back(q);
    }
  }
  sg.ok = true;
  return true;
}

// An object: its element sets in epoch order, split into chains where two
// sets are more than maxGapDays apart (each chain has its own offset a0), and
// the segments joining consecutive sets of a chain.
struct Refusal { uint32_t index; std::string reason; };
struct Object {
  std::string id;
  std::vector<ElementSet> sets;
  std::vector<std::vector<int>> chains;
  std::vector<std::vector<Segment>> segments;
  std::vector<double> a0;  // per chain, km
  double lnB = 0, lnBPrior = 0, lnBSigma = 0, sigmaM = 0;
  std::vector<Refusal> refused;
  std::vector<double> residualM;  // per set (NaN when not in a chain)
  std::vector<char> use;          // per set
};
std::string load_object(const dclObject* o, double fromMjd, double toMjd, double maxGapDays, Object& out) {
  out.id = o->ID() ? o->ID()->str() : std::string();
  std::vector<ElementSet> all;
  const size_t count = size_of(o->ELEMENT_SETS());
  for (size_t k = 0; k < count; ++k) {
    ElementSet s;
    const std::string e = load_set(o->ELEMENT_SETS()->Get(uint32_t(k)), s);
    if (e == "fields")
      return "each element set needs EPOCH (ISO 8601 UTC), MEAN_MOTION (rev/day), ECCENTRICITY, INCLINATION, RA_OF_ASC_NODE, ARG_OF_PERICENTER, "
             "MEAN_ANOMALY (deg) and BSTAR (1/earth radii).";
    if (!e.empty()) {
      out.refused.push_back({uint32_t(k), e});
      continue;
    }
    if (s.mjd < fromMjd || s.mjd > toMjd) continue;
    all.push_back(s);
  }
  std::stable_sort(all.begin(), all.end(), [](const ElementSet& a, const ElementSet& b) { return a.mjd < b.mjd; });
  for (const ElementSet& s : all)
    if (out.sets.empty() || s.mjd > out.sets.back().mjd + 60.0 / 86400.0) out.sets.push_back(s);
  for (size_t k = 0; k < out.sets.size(); ++k) {
    if (k == 0 || out.sets[k].mjd - out.sets[k - 1].mjd > maxGapDays) out.chains.push_back({});
    out.chains.back().push_back(int(k));
  }
  out.segments.resize(out.chains.size());
  for (size_t c = 0; c < out.chains.size(); ++c)
    for (size_t k = 0; k + 1 < out.chains[c].size(); ++k) {
      Segment sg;
      sg.set = out.chains[c][k];
      sg.from = out.sets[sg.set].mjd;
      sg.to = out.sets[out.chains[c][k + 1]].mjd;
      out.segments[c].push_back(sg);
    }
  out.a0.assign(out.chains.size(), 0.0);
  out.residualM.assign(out.sets.size(), std::numeric_limits<double>::quiet_NaN());
  out.use.assign(out.sets.size(), 1);
  // A prior on ln B: sigma 0 = none.
  out.lnBPrior = o->LN_B_PRIOR_MEAN();
  out.lnBSigma = o->LN_B_PRIOR_SIGMA();
  if (!finite(out.lnBPrior) || !(out.lnBSigma >= 0)) return "OBJECTS LN_B_PRIOR needs a finite mean and a sigma >= 0.";
  return "";
}
fb::Offset<fb::Vector<fb::Offset<dclRefusal>>> refusals(fb::FlatBufferBuilder& b, const std::vector<Refusal>& r) {
  std::vector<fb::Offset<dclRefusal>> out;
  for (const Refusal& x : r) out.push_back(CreatedclRefusalDirect(b, x.index, x.reason.c_str()));
  return b.CreateVector(out);
}
// Integrates every segment of an object; false if any fails.
bool integrate_object(Object& ob, double stepS, const Jb2008Table& table, const SunTable& sun, const NodeCorrection& corr, bool gradient) {
  for (auto& chain : ob.segments)
    for (Segment& sg : chain)
      if (!integrate(ob.sets[sg.set], sg, stepS, table, sun, corr, gradient, nullptr)) return false;
  return true;
}
double mean_altitude(const Object& ob) {
  double s = 0, n = 0;
  for (const auto& chain : ob.segments)
    for (const Segment& sg : chain) { s += sg.altSum; n += sg.altCount; }
  return n > 0 ? s / n : std::numeric_limits<double>::quiet_NaN();
}
// Residuals (m) of every set against a0 + B * cumulative D; per-chain index of
// sets; returns the number of sets in chains.
void residuals(Object& ob) {
  const double B = std::exp(ob.lnB);
  for (size_t c = 0; c < ob.chains.size(); ++c) {
    double cum = 0;
    for (size_t k = 0; k < ob.chains[c].size(); ++k) {
      if (k > 0) cum += ob.segments[c][k - 1].D;
      const int s = ob.chains[c][k];
      ob.residualM[s] = (ob.sets[s].aKm - ob.a0[c]) * 1000.0 - B * cum;
    }
  }
}
// Robust scale (1.4826 MAD about the median) of an object's residuals; with
// edit > 0, sets beyond edit robust sigmas of the median are left out.
void robust_sigma(Object& ob, double floorM, double edit) {
  std::vector<double> r;
  for (double x : ob.residualM) if (finite(x)) r.push_back(x);
  if (r.empty()) { ob.sigmaM = floorM; return; }
  const double centre = median_of(r);
  for (double& x : r) x -= centre;
  const double scale = 1.4826 * median_abs(r);
  ob.sigmaM = std::max(floorM, scale);
  if (edit > 0)
    for (size_t s = 0; s < ob.residualM.size(); ++s)
      ob.use[s] = finite(ob.residualM[s]) && std::abs(ob.residualM[s] - centre) <= edit * ob.sigmaM ? 1 : 0;
}

// The settings of a request (an empty table when it has none).
const dclSettings* settings_of(const DCL* request) {
  static fb::FlatBufferBuilder empty = [] {
    fb::FlatBufferBuilder b(64);
    b.Finish(dclSettingsBuilder(b).Finish());
    return b;
  }();
  return request->SETTINGS() ? request->SETTINGS() : fb::GetRoot<dclSettings>(empty.GetBufferPointer());
}
// The input points' own columns, copied into the answer.
struct PointColumns {
  fb::Offset<fb::Vector<int64_t>> time;
  fb::Offset<fb::Vector<double>> lat, lon, alt;
};
PointColumns copy_columns(fb::FlatBufferBuilder& b, const dclPoints* pts) {
  const auto d = [&](const fb::Vector<double>* v) { return v ? b.CreateVector(v->data(), v->size()) : b.CreateVector(std::vector<double>()); };
  return {b.CreateVector(pts->TIME_MS()->data(), pts->TIME_MS()->size()), d(pts->LATITUDE_DEG()), d(pts->LONGITUDE_DEG()), d(pts->ALTITUDE_KM())};
}

}  // namespace

// evaluate: POINTS (with the drivers of ATMOSPHERE, or MODEL_DRIVERS), CORRECTION?, SETTINGS WANT_DERIVATIVE and
// WANT_SUN_DIAGNOSTICS -> POINTS DENSITY_KG_M3 (NaN = refused), DELTA_T_K, LOCAL_SOLAR_TIME_H, DLN_DENSITY_DT_PER_K
// (with WANT_DERIVATIVE), SUN_LONGITUDE_DEG and SUN_LATITUDE_DEG (with WANT_SUN_DIAGNOSTICS; the Sun's Earth-fixed
// direction), REFUSED.
extern "C" int evaluate() {
  std::string e;
  const DCL* request = dcl_request(e);
  if (!request) return fail("invalid-request", e);
  std::vector<Point> points;
  e = load_points(request, points);
  if (!e.empty()) return fail("invalid-request", e);
  Correction correction;
  e = correction.load(request->CORRECTION());
  if (!e.empty()) return fail("invalid-correction", e);
  const dclSettings* settings = settings_of(request);
  const bool derivative = settings->WANT_DERIVATIVE(), diagnostics = settings->WANT_SUN_DIAGNOSTICS();
  bool msisModel = false;
  if (size_of(request->POINTS()->MODEL_DRIVERS()) == 0) atmosphere_of(request, msisModel);
  if (msisModel && (correction.present || derivative || diagnostics))
    return fail("invalid-request", "ATMOSPHERE NRLMSIS00E (NRLMSISE00) has no temperature correction, derivative or Sun diagnostics.");
  const size_t n = points.size();
  std::vector<double> density, deltaT, dlog, lst, sunLon, sunLat;
  std::vector<uint32_t> refused;
  for (size_t i = 0; i < n; ++i) {
    const Point& p = points[i];
    if (!p.ok) {
      refused.push_back(uint32_t(i));
      density.push_back(kNaN); deltaT.push_back(kNaN); lst.push_back(kNaN);
      if (derivative) dlog.push_back(kNaN);
      if (diagnostics) { sunLon.push_back(kNaN); sunLat.push_back(kNaN); }
      continue;
    }
    if (p.msis) {
      double lstHours = 0;
      density.push_back(msis_density(p.mjd, p.lat, p.lon, p.altM, p.f107, p.f107a, p.ap, &lstHours));
      deltaT.push_back(0.0);
      lst.push_back(lstHours);
      continue;
    }
    const double dT = correction.at(p);
    const double rho = rho_at(p, dT);
    density.push_back(rho);
    deltaT.push_back(dT);
    lst.push_back(std::fmod(12.0 + hour_angle(p) / kPi * 12.0 + 24.0, 24.0));
    if (derivative) dlog.push_back((std::log(rho_at(p, dT + 1.0)) - std::log(rho_at(p, dT - 1.0))) / 2.0);
    if (diagnostics) { sunLon.push_back(p.sunLon / kDeg); sunLat.push_back(p.sunLat / kDeg); }
  }
  fb::FlatBufferBuilder b(1024 + n * 80);
  const PointColumns cols = copy_columns(b, request->POINTS());
  const auto vDensity = doubles(b, density), vDeltaT = doubles(b, deltaT), vLst = doubles(b, lst);
  const auto vRefused = indices(b, refused);
  const fb::Offset<fb::Vector<double>> vDlog = derivative ? doubles(b, dlog) : fb::Offset<fb::Vector<double>>();
  const fb::Offset<fb::Vector<double>> vSunLon = diagnostics ? doubles(b, sunLon) : fb::Offset<fb::Vector<double>>();
  const fb::Offset<fb::Vector<double>> vSunLat = diagnostics ? doubles(b, sunLat) : fb::Offset<fb::Vector<double>>();
  dclPointsBuilder pb(b);
  pb.add_TIME_MS(cols.time);
  pb.add_LATITUDE_DEG(cols.lat);
  pb.add_LONGITUDE_DEG(cols.lon);
  pb.add_ALTITUDE_KM(cols.alt);
  pb.add_DENSITY_KG_M3(vDensity);
  pb.add_DELTA_T_K(vDeltaT);
  pb.add_LOCAL_SOLAR_TIME_H(vLst);
  if (derivative) pb.add_DLN_DENSITY_DT_PER_K(vDlog);
  if (diagnostics) { pb.add_SUN_LONGITUDE_DEG(vSunLon); pb.add_SUN_LATITUDE_DEG(vSunLat); }
  pb.add_REFUSED(vRefused);
  const auto pointsOut = pb.Finish();
  const auto atm = atmosphere_record(b, msisModel);
  const auto corr = correction.record(b);
  dclSettingsBuilder sb(b);
  sb.add_WANT_DERIVATIVE(derivative);
  sb.add_WANT_SUN_DIAGNOSTICS(diagnostics);
  const auto set = sb.Finish();
  DCLBuilder d(b);
  d.add_PRODUCT(dclProduct::DensityEvaluation);
  d.add_ATMOSPHERE(atm);
  d.add_SETTINGS(set);
  if (correction.present) d.add_CORRECTION(corr);
  d.add_STATUS(dclStatus::Solved);
  d.add_POINTS(pointsOut);
  return emit("result", b, d.Finish());
}

// calibrate: POINTS with OBSERVED_DENSITY_KG_M3 (and WEIGHT), the JB2008 drivers (or MODEL_DRIVERS), SETTINGS FROM_MS,
// TO_MS, DEGREE, BIN_S, LOG_DENSITY_SIGMA, PRIOR_SIGMA_K [per degree], MIN_POINTS, MAX_ITERATIONS, EDIT_SIGMA (< 0: no
// editing) -> CORRECTION Harmonic: per bin a segment with COEFFICIENTS_K, SIGMAS_K and its FIT (OBSERVATIONS, USED,
// PARAMETERS, PREFIT_RMS, POSTFIT_RMS, ITERATIONS, CONVERGED); a bin with too few points has no coefficients.
extern "C" int calibrate() {
  std::string e;
  const DCL* request = dcl_request(e);
  if (!request) return fail("invalid-request", e);
  const dclPoints* pts = request->POINTS();
  bool msisModel = false;
  e = atmosphere_of(request, msisModel);
  if (!e.empty() || msisModel)
    return fail("invalid-request", "calibrate fits the JB2008 temperature correction only.");
  std::vector<Point> points;
  e = load_points(request, points);
  if (!e.empty()) return fail("invalid-request", e);
  const auto* observed = pts->OBSERVED_DENSITY_KG_M3();
  if (size_of(observed) != points.size()) return fail("invalid-request", "POINTS OBSERVED_DENSITY_KG_M3 must have one value per point.");
  std::vector<double> rho(points.size(), 0.0), weight(points.size(), 1.0);
  for (size_t i = 0; i < points.size(); ++i) rho[i] = observed->Get(uint32_t(i));
  if (size_of(pts->WEIGHT()) == points.size())
    for (size_t i = 0; i < points.size(); ++i) weight[i] = pts->WEIGHT()->Get(uint32_t(i));
  const dclSettings* settings = settings_of(request);
  const int degree = settings->DEGREE();
  if (degree < 0 || degree > 8) return fail("invalid-request", "SETTINGS DEGREE must be 0-8.");
  const int K = basis_size(degree);
  const double binHours = settings->BIN_S() != 0 ? settings->BIN_S() / 3600.0 : 3.0;
  const double binDays = binHours / 24.0;
  const double from = mjd_of_ms(settings->FROM_MS()), to = mjd_of_ms(settings->TO_MS());
  if (!(binDays > 0) || !(to > from)) return fail("invalid-request", "SETTINGS BIN_S > 0 and TO_MS > FROM_MS are required.");
  const double logSigma = settings->LOG_DENSITY_SIGMA() != 0 ? settings->LOG_DENSITY_SIGMA() : 0.1;
  std::vector<double> priorSigma(degree + 1, 100.0);
  if (size_of(settings->PRIOR_SIGMA_K()) != 0) {
    if (int(settings->PRIOR_SIGMA_K()->size()) != degree + 1) return fail("invalid-request", "SETTINGS PRIOR_SIGMA_K needs one value per degree.");
    for (int l = 0; l <= degree; ++l) priorSigma[l] = settings->PRIOR_SIGMA_K()->Get(uint32_t(l));
  }
  const int minPoints = settings->MIN_POINTS() != 0 ? int(settings->MIN_POINTS()) : 30;
  const int maxIterations = settings->MAX_ITERATIONS() != 0 ? int(settings->MAX_ITERATIONS()) : 10;
  const double editSigma = settings->EDIT_SIGMA() != 0 ? settings->EDIT_SIGMA() : 4.0;
  std::vector<double> priorDiag(K);
  for (int l = 0, k = 0; l <= degree; ++l)
    for (int c = 0; c < 2 * l + 1; ++c, ++k) priorDiag[k] = 1.0 / (priorSigma[l] * priorSigma[l]);

  const long nBins = long(std::ceil((to - from) / binDays - 1e-9));
  std::vector<std::vector<size_t>> members(nBins);
  for (size_t i = 0; i < points.size(); ++i) {
    if (!points[i].ok || !positive(rho[i]) || !(weight[i] > 0)) continue;
    const long bin = long(std::floor((points[i].mjd - from) / binDays));
    if (bin >= 0 && bin < nBins) members[bin].push_back(i);
  }
  fb::FlatBufferBuilder b(4096);
  std::vector<fb::Offset<dclHarmonicSegment>> bins;
  std::vector<double> y(K);
  for (long bin = 0; bin < nBins; ++bin) {
    const std::vector<size_t>& idx = members[bin];
    const int64_t fromMs = ms_of_mjd(from + bin * binDays), toMs = ms_of_mjd(from + (bin + 1) * binDays);
    if (long(idx.size()) < minPoints) {
      dclFitStatisticsBuilder fs(b);
      fs.add_OBSERVATIONS(uint32_t(idx.size()));
      fs.add_PARAMETERS(uint32_t(K));
      const auto fit = fs.Finish();
      dclHarmonicSegmentBuilder g(b);
      g.add_FROM_MS(fromMs);
      g.add_TO_MS(toMs);
      g.add_FIT(fit);
      bins.push_back(g.Finish());
      continue;
    }
    std::vector<double> c(K, 0.0), r(idx.size()), g(idx.size());
    std::vector<char> use(idx.size(), 1);
    std::vector<std::vector<double>> Y(idx.size(), std::vector<double>(K));
    for (size_t j = 0; j < idx.size(); ++j) basis(degree, points[idx[j]].lat, hour_angle(points[idx[j]]), Y[j].data());
    const auto residuals = [&]() {
      for (size_t j = 0; j < idx.size(); ++j) {
        const Point& p = points[idx[j]];
        double dT = 0;
        for (int k = 0; k < K; ++k) dT += c[k] * Y[j][k];
        const double model = rho_at(p, dT);
        r[j] = std::log(rho[idx[j]]) - std::log(model);
        g[j] = (std::log(rho_at(p, dT + 1.0)) - std::log(rho_at(p, dT - 1.0))) / 2.0;
      }
    };
    const auto rms = [&]() {
      double s = 0, w = 0;
      for (size_t j = 0; j < idx.size(); ++j) if (use[j]) { s += weight[idx[j]] * r[j] * r[j]; w += weight[idx[j]]; }
      return w > 0 ? std::sqrt(s / w) : 0.0;
    };
    residuals();
    const double prefit = rms();
    int iterations = 0;
    bool converged = false;
    std::vector<double> inverse;
    for (; iterations < maxIterations; ++iterations) {
      if (iterations >= 1 && editSigma > 0) {
        std::vector<double> kept;
        for (size_t j = 0; j < idx.size(); ++j) kept.push_back(r[j]);
        double centre = 0;
        { std::vector<double> s = kept; std::nth_element(s.begin(), s.begin() + s.size() / 2, s.end()); centre = s[s.size() / 2]; }
        for (double& x : kept) x -= centre;
        const double robust = 1.4826 * median_abs(kept);
        for (size_t j = 0; j < idx.size(); ++j) use[j] = robust > 0 ? std::abs(r[j] - centre) <= editSigma * robust : 1;
      }
      std::vector<double> A(K * K, 0.0), rhs(K, 0.0);
      for (size_t j = 0; j < idx.size(); ++j) {
        if (!use[j]) continue;
        const double w = weight[idx[j]] / (logSigma * logSigma);
        for (int a = 0; a < K; ++a) {
          const double ja = g[j] * Y[j][a];
          rhs[a] += w * ja * r[j];
          for (int bb = 0; bb <= a; ++bb) A[a * K + bb] += w * ja * g[j] * Y[j][bb];
        }
      }
      for (int a = 0; a < K; ++a) {
        for (int bb = 0; bb < a; ++bb) A[bb * K + a] = A[a * K + bb];
        A[a * K + a] += priorDiag[a];
        rhs[a] -= priorDiag[a] * c[a];
      }
      if (!cholesky_solve(A, rhs, K, &inverse)) break;
      double largest = 0;
      for (int a = 0; a < K; ++a) {
        const double step = std::max(-200.0, std::min(200.0, rhs[a]));
        c[a] += step;
        largest = std::max(largest, std::abs(step));
      }
      residuals();
      if (largest < 0.01) { converged = true; ++iterations; break; }
    }
    long used = 0;
    for (char u : use) used += u;
    std::vector<double> sigmas;
    if (!inverse.empty())
      for (int a = 0; a < K; ++a) sigmas.push_back(std::sqrt(inverse[a * K + a]));
    const double postfit = rms();
    const auto vc = doubles(b, c), vs = doubles(b, sigmas);
    dclFitStatisticsBuilder fs(b);
    fs.add_ITERATIONS(uint32_t(iterations));
    fs.add_CONVERGED(converged);
    fs.add_OBSERVATIONS(uint32_t(idx.size()));
    fs.add_USED(uint32_t(used));
    fs.add_PARAMETERS(uint32_t(K));
    fs.add_PREFIT_RMS(prefit);
    fs.add_POSTFIT_RMS(postfit);
    const auto fit = fs.Finish();
    dclHarmonicSegmentBuilder sg(b);
    sg.add_FROM_MS(fromMs);
    sg.add_TO_MS(toMs);
    sg.add_COEFFICIENTS_K(vc);
    sg.add_SIGMAS_K(vs);
    sg.add_FIT(fit);
    bins.push_back(sg.Finish());
  }
  const auto segs = b.CreateVector(bins);
  dclCorrectionBuilder cb(b);
  cb.add_FORM(dclCorrectionForm::Harmonic);
  cb.add_DEGREE(uint8_t(degree));
  cb.add_SEGMENTS(segs);
  const auto corr = cb.Finish();
  const auto prior = doubles(b, priorSigma);
  dclSettingsBuilder sb(b);
  sb.add_FROM_MS(settings->FROM_MS());
  sb.add_TO_MS(settings->TO_MS());
  sb.add_DEGREE(uint8_t(degree));
  sb.add_BIN_S(binHours * 3600.0);
  sb.add_LOG_DENSITY_SIGMA(logSigma);
  sb.add_PRIOR_SIGMA_K(prior);
  sb.add_MIN_POINTS(uint32_t(minPoints));
  sb.add_MAX_ITERATIONS(uint32_t(maxIterations));
  sb.add_EDIT_SIGMA(editSigma);
  const auto set = sb.Finish();
  const auto atm = atmosphere_record(b, false);
  DCLBuilder d(b);
  d.add_PRODUCT(dclProduct::DensityCalibration);
  d.add_ATMOSPHERE(atm);
  d.add_SETTINGS(set);
  d.add_CORRECTION(corr);
  d.add_STATUS(dclStatus::Solved);
  return emit("calibration", b, d.Finish());
}

namespace {
// The UTC span of every set (and, for decay, its one-set span) for the Sun table.
void set_span(const std::vector<Object>& objects, double extraDays, double& lo, double& hi) {
  lo = std::numeric_limits<double>::infinity();
  hi = -lo;
  for (const Object& ob : objects)
    for (const ElementSet& s : ob.sets) { lo = std::min(lo, s.mjd); hi = std::max(hi, s.mjd + extraDays); }
}
// The per-set columns of an object (time, mean semi-major axis, perigee height, eccentricity).
struct SetColumns {
  fb::Offset<fb::Vector<int64_t>> time;
  fb::Offset<fb::Vector<double>> a, perigee, ecc;
};
SetColumns set_columns(fb::FlatBufferBuilder& b, const Object& ob) {
  std::vector<double> t, a, p, e;
  for (const ElementSet& s : ob.sets) { t.push_back(s.mjd); a.push_back(s.aKm); p.push_back(s.perigeeKm); e.push_back(s.ecc); }
  return {times(b, t), doubles(b, a), doubles(b, p), doubles(b, e)};
}
}  // namespace

// decay: the forward model. JB2008_DRIVERS, OBJECTS [{ID, ELEMENT_SETS ($OMM), BALLISTIC_COEFFICIENT_M2_KG (0 = 1),
// SPAN_S (one set: integrate it alone over this span)}], CORRECTION? (Nodes), SETTINGS STEP_S, MAX_GAP_S, WANT_SAMPLES ->
// per object the sets' mean semi-major axes, the drag change over each segment (B * D) and its cumulative sum at each
// set, the mean geodetic altitude, and with WANT_SAMPLES every trajectory point (TEME state, geodetic point, density, q).
extern "C" int decay() {
  std::string e;
  const DCL* request = dcl_request(e);
  if (!request) return fail("invalid-request", e);
  Jb2008Table table;
  e = table.add(request->JB2008_DRIVERS());
  if (!e.empty()) return fail("invalid-request", e);
  NodeCorrection corr;
  const dclCorrection* given = request->CORRECTION();
  const bool corrected = given && given->FORM() != dclCorrectionForm::None;
  if (corrected) {
    if (given->FORM() != dclCorrectionForm::Nodes) return fail("invalid-correction", "decay takes a correction in time nodes (FORM Nodes).");
    e = corr.load(given);
    if (!e.empty()) return fail("invalid-correction", e);
  } else {
    corr.t = {0.0};
    corr.v = {0.0};
  }
  const dclSettings* settings = settings_of(request);
  const double stepS = settings->STEP_S() != 0 ? settings->STEP_S() : 60.0;
  const double maxGap = settings->MAX_GAP_S() != 0 ? settings->MAX_GAP_S() / 86400.0 : 3.0;
  if (!(stepS >= 1 && stepS <= 600)) return fail("invalid-request", "SETTINGS STEP_S must be 1-600.");
  const bool wantSamples = settings->WANT_SAMPLES();
  const auto* list = request->OBJECTS();
  if (size_of(list) == 0) return fail("invalid-request", "OBJECTS must hold at least one object.");
  std::vector<Object> objects(list->size());
  std::vector<double> span(list->size(), 0.0), B(list->size(), 1.0);
  double extra = 0;
  for (size_t i = 0; i < list->size(); ++i) {
    const dclObject* o = list->Get(uint32_t(i));
    e = load_object(o, -1e9, 1e9, maxGap, objects[i]);
    if (!e.empty()) return fail("invalid-request", e);
    span[i] = o->SPAN_S() / 86400.0;
    B[i] = o->BALLISTIC_COEFFICIENT_M2_KG() != 0 ? o->BALLISTIC_COEFFICIENT_M2_KG() : 1.0;
    if (!(span[i] >= 0 && span[i] <= 30) || !positive(B[i])) return fail("invalid-request", "SPAN_S must be 0-30 days and B positive.");
    if (objects[i].sets.size() == 1 && span[i] > 0) {
      Segment sg;
      sg.set = 0;
      sg.from = objects[i].sets[0].mjd;
      sg.to = sg.from + span[i];
      objects[i].segments[0].push_back(sg);
    }
    extra = std::max(extra, span[i]);
  }
  double lo = 0, hi = 0;
  set_span(objects, extra, lo, hi);
  SunTable sun;
  sun.build(lo - 0.1, hi + 0.1);
  fb::FlatBufferBuilder b(4096);
  std::vector<fb::Offset<dclObject>> out;
  for (size_t i = 0; i < objects.size(); ++i) {
    Object& ob = objects[i];
    Samples samples;
    std::vector<double> segFrom, segTo, segDecay, segAlt;
    std::vector<double> cumulative(ob.sets.size(), std::numeric_limits<double>::quiet_NaN());
    bool ok = true;
    for (size_t c = 0; c < ob.chains.size() && ok; ++c) {
      double cum = 0;
      cumulative[ob.chains[c][0]] = 0;
      for (size_t k = 0; k < ob.segments[c].size(); ++k) {
        Segment& sg = ob.segments[c][k];
        if (!integrate(ob.sets[sg.set], sg, stepS, table, sun, corr, false, wantSamples ? &samples : nullptr)) { ok = false; break; }
        cum += B[i] * sg.D;
        if (k + 1 < ob.chains[c].size()) cumulative[ob.chains[c][k + 1]] = cum;
        segFrom.push_back(sg.from);
        segTo.push_back(sg.to);
        segDecay.push_back(B[i] * sg.D);
        segAlt.push_back(sg.altSum / std::max(1.0, sg.altCount));
      }
    }
    const auto id = b.CreateString(ob.id);
    const auto refused = refusals(b, ob.refused);
    const SetColumns sc = set_columns(b, ob);
    const auto vCum = doubles(b, cumulative);
    const auto vSegFrom = times(b, segFrom), vSegTo = times(b, segTo);
    const auto vSegDecay = doubles(b, segDecay), vSegAlt = doubles(b, segAlt);
    fb::Offset<fb::Vector<int64_t>> sTime;
    fb::Offset<fb::Vector<double>> sTeme, sLat, sLon, sAlt, sRho, sQ;
    if (wantSamples) {
      sTime = times(b, samples.mjd);
      sTeme = doubles(b, samples.teme);
      sLat = doubles(b, samples.lat);
      sLon = doubles(b, samples.lon);
      sAlt = doubles(b, samples.alt);
      sRho = doubles(b, samples.rho);
      sQ = doubles(b, samples.q);
    }
    dclObjectBuilder o(b);
    o.add_ID(id);
    o.add_BALLISTIC_COEFFICIENT_M2_KG(B[i]);
    o.add_SPAN_S(list->Get(uint32_t(i))->SPAN_S());
    o.add_OK(ok);
    o.add_REFUSED(refused);
    o.add_SET_TIME_MS(sc.time);
    o.add_SET_MEAN_SEMI_MAJOR_AXIS_KM(sc.a);
    o.add_SET_PERIGEE_HEIGHT_KM(sc.perigee);
    o.add_SET_ECCENTRICITY(sc.ecc);
    o.add_SET_CUMULATIVE_DECAY_M(vCum);
    o.add_SEGMENT_FROM_MS(vSegFrom);
    o.add_SEGMENT_TO_MS(vSegTo);
    o.add_SEGMENT_DECAY_M(vSegDecay);
    o.add_SEGMENT_MEAN_ALTITUDE_KM(vSegAlt);
    o.add_MEAN_ALTITUDE_KM(ok ? mean_altitude(ob) : kNaN);
    if (wantSamples) {
      o.add_SAMPLE_TIME_MS(sTime);
      o.add_SAMPLE_TEME_STATE(sTeme);
      o.add_SAMPLE_LATITUDE_DEG(sLat);
      o.add_SAMPLE_LONGITUDE_DEG(sLon);
      o.add_SAMPLE_ALTITUDE_KM(sAlt);
      o.add_SAMPLE_DENSITY_KG_M3(sRho);
      o.add_SAMPLE_DECAY_FACTOR_M2_S(sQ);
    }
    out.push_back(o.Finish());
  }
  const auto objs = b.CreateVector(out);
  const auto corrOut = corrected ? corr.record(b, nullptr) : fb::Offset<dclCorrection>();
  dclSettingsBuilder sb(b);
  sb.add_STEP_S(stepS);
  sb.add_MAX_GAP_S(maxGap * 86400.0);
  sb.add_WANT_SAMPLES(wantSamples);
  const auto set = sb.Finish();
  const auto atm = atmosphere_record(b, false);
  DCLBuilder d(b);
  d.add_PRODUCT(dclProduct::OrbitalDecay);
  d.add_ATMOSPHERE(atm);
  d.add_SETTINGS(set);
  if (corrected) d.add_CORRECTION(corrOut);
  d.add_STATUS(dclStatus::Solved);
  d.add_OBJECTS(objs);
  return emit("result", b, d.Finish());
}

// calibrate_decay: the temperature correction (time nodes, optionally linear
// in altitude) and every object's ballistic coefficient, from the objects'
// element-set histories: Gauss-Newton on the sets' mean semi-major axes,
//   a_k = a0_chain + B * sum over the segments before k of D(correction),
// weighted by each object's robust residual scale, with a random-walk prior
// on the correction, a prior on its mean level, an optional prior tying
// altitude nodes, and each object's prior on ln B (anchors: known area to
// mass). JB2008_DRIVERS, OBJECTS [{ID, ELEMENT_SETS, LN_B_PRIOR_MEAN/SIGMA}],
// SETTINGS FROM_MS, TO_MS, NODE_STEP_S (0 = 6 h), NODE_ALTITUDES_KM,
// RANDOM_WALK_K_PER_SQRT_DAY, MEAN_LEVEL_K, ALTITUDE_DIFFERENCE_K, STEP_S,
// MAX_GAP_S, RESIDUAL_FLOOR_M, EDIT_SIGMA (< 0: no editing), MAX_ITERATIONS,
// REWEIGHT_ITERATIONS, TOLERANCE_K/LN_B/OFFSET_M, MIN_SETS, WANT_RESIDUALS.
extern "C" int calibrate_decay() {
  std::string e;
  const DCL* request = dcl_request(e);
  if (!request) return fail("invalid-request", e);
  Jb2008Table table;
  e = table.add(request->JB2008_DRIVERS());
  if (!e.empty()) return fail("invalid-request", e);
  const dclSettings* settings = settings_of(request);
  const double from = mjd_of_ms(settings->FROM_MS()), to = mjd_of_ms(settings->TO_MS());
  const double stepH = settings->NODE_STEP_S() != 0 ? settings->NODE_STEP_S() / 3600.0 : 6.0;
  if (!(to > from) || !(stepH > 0)) return fail("invalid-request", "SETTINGS FROM_MS, TO_MS > FROM_MS and NODE_STEP_S > 0 are required.");
  NodeCorrection corr;
  const int M = int(std::ceil((to - from) / (stepH / 24.0) - 1e-9)) + 1;
  if (M > 4000) return fail("invalid-request", "too many correction nodes.");
  for (int j = 0; j < M; ++j) corr.t.push_back(from + j * stepH / 24.0);
  if (settings->NODE_ALTITUDES_KM()) for (const double a : *settings->NODE_ALTITUDES_KM()) corr.alt.push_back(a);
  if (corr.alt.size() == 1) return fail("invalid-request", "SETTINGS NODE_ALTITUDES_KM needs none (global) or at least two altitudes.");
  for (size_t a = 1; a < corr.alt.size(); ++a)
    if (!(corr.alt[a] > corr.alt[a - 1])) return fail("invalid-request", "SETTINGS NODE_ALTITUDES_KM must increase.");
  const int P = corr.P(), nTheta = M * P;
  corr.v.assign(size_t(nTheta), 0.0);
  const double rw = settings->RANDOM_WALK_K_PER_SQRT_DAY() != 0 ? settings->RANDOM_WALK_K_PER_SQRT_DAY() : 30.0;
  const double meanK = settings->MEAN_LEVEL_K() != 0 ? settings->MEAN_LEVEL_K() : 150.0;
  const double diffK = settings->ALTITUDE_DIFFERENCE_K() != 0 ? settings->ALTITUDE_DIFFERENCE_K() : 100.0;
  if (!positive(rw) || !positive(meanK) || !positive(diffK)) return fail("invalid-request", "SETTINGS priors must be positive.");
  const double stepS = settings->STEP_S() != 0 ? settings->STEP_S() : 60.0;
  const double maxGap = settings->MAX_GAP_S() != 0 ? settings->MAX_GAP_S() / 86400.0 : 3.0;
  const double floorM = settings->RESIDUAL_FLOOR_M() != 0 ? settings->RESIDUAL_FLOOR_M() : 1.0;
  const double edit = settings->EDIT_SIGMA() != 0 ? settings->EDIT_SIGMA() : 4.0;
  // Residual scales and edits are re-estimated in the first reweight
  // iterations and then held, so that Gauss-Newton converges on a fixed problem.
  const int reweight = settings->REWEIGHT_ITERATIONS() != 0 ? int(settings->REWEIGHT_ITERATIONS()) : 4;
  const int maxIt = settings->MAX_ITERATIONS() != 0 ? int(settings->MAX_ITERATIONS()) : 10;
  const int minSets = settings->MIN_SETS() != 0 ? int(settings->MIN_SETS()) : 5;
  const double tolK = settings->TOLERANCE_K() != 0 ? settings->TOLERANCE_K() : 0.5;
  const double tolLnB = settings->TOLERANCE_LN_B() != 0 ? settings->TOLERANCE_LN_B() : 1e-3;
  const double tolA0 = settings->TOLERANCE_OFFSET_M() != 0 ? settings->TOLERANCE_OFFSET_M() : 0.1;
  if (!positive(tolK) || !positive(tolLnB) || !positive(tolA0)) return fail("invalid-request", "SETTINGS TOLERANCE_K, TOLERANCE_LN_B and TOLERANCE_OFFSET_M must be positive.");
  struct Step { int iteration; double chi2; long observations; double big, bigB, bigA; };
  std::vector<Step> history;
  const bool wantResiduals = settings->WANT_RESIDUALS();
  if (!(stepS >= 1 && stepS <= 600) || !positive(floorM)) return fail("invalid-request", "SETTINGS STEP_S must be 1-600 and RESIDUAL_FLOOR_M positive.");

  // Objects: sets inside the node span, chains of at least two sets.
  const auto* list = request->OBJECTS();
  std::vector<Object> objects;
  struct Skipped { std::string id, reason; long sets; bool counted; std::vector<Refusal> refused; };
  std::vector<Skipped> skipped;
  for (size_t li = 0; li < size_of(list); ++li) {
    Object ob;
    e = load_object(list->Get(uint32_t(li)), from, to, maxGap, ob);
    if (!e.empty()) return fail("invalid-request", e);
    std::vector<std::vector<int>> chains;
    std::vector<std::vector<Segment>> segments;
    size_t used = 0;
    for (size_t c = 0; c < ob.chains.size(); ++c) {
      if (ob.chains[c].size() < 2) {
        for (int s : ob.chains[c]) ob.use[s] = 0;
        continue;
      }
      chains.push_back(ob.chains[c]);
      segments.push_back(ob.segments[c]);
      used += ob.chains[c].size();
    }
    ob.chains = chains;
    ob.segments = segments;
    ob.a0.assign(chains.size(), 0.0);
    if (int(used) < minSets) {
      skipped.push_back({ob.id, "fewer than MIN_SETS sets in chains", long(used), true, ob.refused});
      continue;
    }
    if (!(ob.lnBSigma > 0)) ob.lnBSigma = 0;
    objects.push_back(std::move(ob));
  }
  double lo = 0, hi = 0;
  set_span(objects, 0.0, lo, hi);
  if (objects.empty()) return fail("invalid-request", "no object has enough element sets in the node span.");
  SunTable sun;
  sun.build(std::min(lo, from) - 0.1, std::max(hi, to) + 0.1);

  // Start: the correction at zero, each object's B and offsets by linear least
  // squares; an object whose drag cannot be resolved starts at its prior (or
  // at Cd A/m = 12.741621 B*, or 0.01 m^2/kg) and keeps a weak prior.
  std::vector<Object> kept;
  for (Object& ob : objects) {
    if (!integrate_object(ob, stepS, table, sun, corr, false)) {
      skipped.push_back({ob.id, "trajectory outside the drivers, below 90 km or refused by SGP4", 0, false, ob.refused});
      continue;
    }
    double sxx = 0, sxy = 0;
    std::vector<double> xm(ob.chains.size(), 0.0), ym(ob.chains.size(), 0.0);
    for (size_t c = 0; c < ob.chains.size(); ++c) {
      double cum = 0;
      for (size_t k = 0; k < ob.chains[c].size(); ++k) {
        if (k > 0) cum += ob.segments[c][k - 1].D;
        xm[c] += cum / ob.chains[c].size();
        ym[c] += ob.sets[ob.chains[c][k]].aKm * 1000.0 / ob.chains[c].size();
      }
      cum = 0;
      for (size_t k = 0; k < ob.chains[c].size(); ++k) {
        if (k > 0) cum += ob.segments[c][k - 1].D;
        sxx += (cum - xm[c]) * (cum - xm[c]);
        sxy += (cum - xm[c]) * (ob.sets[ob.chains[c][k]].aKm * 1000.0 - ym[c]);
      }
    }
    double B = sxx > 0 ? sxy / sxx : 0;
    if (!positive(B)) B = ob.lnBSigma > 0 ? std::exp(ob.lnBPrior) : (ob.sets[0].bstar > 1e-6 ? 12.741621 * ob.sets[0].bstar : 0.01);
    if (!(ob.lnBSigma > 0)) { ob.lnBPrior = std::log(B); ob.lnBSigma = 10.0; }
    ob.lnB = std::log(B);
    for (size_t c = 0; c < ob.chains.size(); ++c) ob.a0[c] = (ym[c] - B * xm[c]) / 1000.0;
    residuals(ob);
    robust_sigma(ob, floorM, 0);
    kept.push_back(std::move(ob));
  }
  objects = std::move(kept);
  if (objects.empty()) return fail("invalid-request", "no object could be integrated.");
  std::vector<double> prefit(objects.size(), 0.0);
  for (size_t i = 0; i < objects.size(); ++i) {
    double s = 0, n = 0;
    for (double r : objects[i].residualM) if (std::isfinite(r)) { s += r * r; ++n; }
    prefit[i] = n > 0 ? std::sqrt(s / n) : 0;
  }

  // Parameters: the correction, then ln B per object, then a0 per chain (m).
  const int N = int(objects.size());
  std::vector<int> chainBase(N, 0);
  int C = 0;
  for (int i = 0; i < N; ++i) { chainBase[i] = nTheta + N + C; C += int(objects[i].chains.size()); }
  const int n = nTheta + N + C;
  if (n > 6000) return fail("invalid-request", "too many parameters (nodes x altitudes + objects + chains > 6000).");
  std::vector<double> NM, rhs;
  int iterations = 0;
  bool converged = false;
  double chi2 = 0;
  long observations = 0;
  const double stepDays = stepH / 24.0;
  const auto build = [&]() {
    NM.assign(size_t(n) * n, 0.0);
    rhs.assign(n, 0.0);
    chi2 = 0;
    observations = 0;
    for (int i = 0; i < N; ++i) {
      Object& ob = objects[i];
      const double B = std::exp(ob.lnB), w = 1.0 / (ob.sigmaM * ob.sigmaM);
      const int iB = nTheta + i;
      for (size_t c = 0; c < ob.chains.size(); ++c) {
        const auto& segs = ob.segments[c];
        const int jlo = segs.front().j0, jhi = segs.back().j1, ia0 = chainBase[i] + int(c);
        std::vector<double> cumG(size_t(jhi - jlo + 1) * P, 0.0);
        double cumD = 0;
        int top = jlo - 1;
        for (size_t k = 0; k < ob.chains[c].size(); ++k) {
          if (k > 0) {
            const Segment& sg = segs[k - 1];
            cumD += sg.D;
            for (int j = sg.j0; j <= sg.j1; ++j)
              for (int a = 0; a < P; ++a) cumG[size_t(j - jlo) * P + a] += sg.G[size_t(j - sg.j0) * P + a];
            top = std::max(top, sg.j1);
          }
          const int s = ob.chains[c][k];
          if (!ob.use[s]) continue;
          const double r = ob.residualM[s], A = B * cumD;
          chi2 += w * r * r;
          ++observations;
          const int L = jlo * P, len = (top - jlo + 1) * P;
          for (int u = 0; u < len; ++u) {
            const double xu = B * cumG[u];
            if (xu == 0) continue;
            double* row = &NM[size_t(L + u) * n + L];
            const double wx = w * xu;
            for (int v = 0; v <= u; ++v) row[v] += wx * B * cumG[v];
            rhs[L + u] += wx * r;
            NM[size_t(iB) * n + (L + u)] += wx * A;
            NM[size_t(ia0) * n + (L + u)] += wx;
          }
          NM[size_t(iB) * n + iB] += w * A * A;
          NM[size_t(ia0) * n + ia0] += w;
          NM[size_t(ia0) * n + iB] += w * A;
          rhs[iB] += w * A * r;
          rhs[ia0] += w * r;
        }
      }
      // ln B prior.
      const double s2 = ob.lnBSigma * ob.lnBSigma;
      NM[size_t(iB) * n + iB] += 1.0 / s2;
      rhs[iB] -= (ob.lnB - ob.lnBPrior) / s2;
    }
    // Random walk between consecutive nodes, per altitude node.
    const double qrw = rw * rw * stepDays;
    for (int a = 0; a < P; ++a)
      for (int j = 0; j + 1 < M; ++j) {
        const int i1 = j * P + a, i2 = (j + 1) * P + a;
        const double d = corr.v[i2] - corr.v[i1];
        NM[size_t(i1) * n + i1] += 1 / qrw;
        NM[size_t(i2) * n + i2] += 1 / qrw;
        NM[size_t(i2) * n + i1] -= 1 / qrw;
        rhs[i1] += d / qrw;
        rhs[i2] -= d / qrw;
      }
    // The mean level of each altitude node.
    for (int a = 0; a < P; ++a) {
      double m = 0;
      for (int j = 0; j < M; ++j) m += corr.v[j * P + a] / M;
      const double h = 1.0 / (double(M) * M * meanK * meanK);
      for (int j = 0; j < M; ++j) {
        for (int k = 0; k <= j; ++k) NM[size_t(j * P + a) * n + (k * P + a)] += h;
        rhs[j * P + a] -= m / (double(M) * meanK * meanK);
      }
    }
    // Neighbouring altitude nodes tied loosely at each time node.
    for (int j = 0; j < M; ++j)
      for (int a = 1; a < P; ++a) {
        const int i1 = j * P + a - 1, i2 = j * P + a;
        const double d = corr.v[i2] - corr.v[i1], h = 1.0 / (diffK * diffK);
        NM[size_t(i1) * n + i1] += h;
        NM[size_t(i2) * n + i2] += h;
        NM[size_t(i2) * n + i1] -= h;
        rhs[i1] += d * h;
        rhs[i2] -= d * h;
      }
  };
  // Each object's ln B step is limited to 1 and scaled by lnBScale[i] (1 at
  // first), halved whenever the step reverses sign: an object whose sets do
  // not decay as drag would (radiation pressure above ~800 km) otherwise
  // alternates between two values, while the correction has converged.
  // While the scales and edits are re-estimated the objective changes from
  // one iteration to the next and steps reverse for that reason alone, so
  // the damping starts afresh once they are held: it then slows only an
  // object that alternates under a fixed objective.
  std::vector<double> lnBScale(N, 1.0), lnBLast(N, 0.0);
  for (; iterations < maxIt; ++iterations) {
    if (iterations == reweight) {
      std::fill(lnBScale.begin(), lnBScale.end(), 1.0);
      std::fill(lnBLast.begin(), lnBLast.end(), 0.0);
    }
    bool ok = true;
    for (Object& ob : objects) ok = integrate_object(ob, stepS, table, sun, corr, true) && ok;
    if (!ok) return fail("integration-failed", "a trajectory left the drivers' span during the iterations.");
    for (Object& ob : objects) {
      residuals(ob);
      if (iterations < reweight) robust_sigma(ob, floorM, iterations >= 1 ? edit : 0);
    }
    build();
    if (!cholesky_solve(NM, rhs, n, nullptr)) break;
    double big = 0, bigB = 0, bigA = 0;
    for (int k = 0; k < nTheta; ++k) {
      const double step = std::max(-100.0, std::min(100.0, rhs[k]));
      corr.v[k] += step;
      big = std::max(big, std::abs(step));
    }
    for (int i = 0; i < N; ++i) {
      if (rhs[nTheta + i] * lnBLast[i] < 0) lnBScale[i] *= 0.5;
      const double step = std::max(-1.0, std::min(1.0, lnBScale[i] * rhs[nTheta + i]));
      lnBLast[i] = step;
      objects[i].lnB += step;
      bigB = std::max(bigB, std::abs(step));
      for (size_t c = 0; c < objects[i].chains.size(); ++c) {
        objects[i].a0[c] += rhs[chainBase[i] + c] / 1000.0;
        bigA = std::max(bigA, std::abs(rhs[chainBase[i] + c]));
      }
    }
    history.push_back({iterations + 1, chi2, observations, big, bigB, bigA});
    if (iterations + 1 >= reweight && big < tolK && bigB < tolLnB && bigA < tolA0) { converged = true; ++iterations; break; }
  }
  // The solution: residuals and the formal covariance there, under the scales
  // and edits the solution was found with.
  for (Object& ob : objects)
    if (!integrate_object(ob, stepS, table, sun, corr, true)) return fail("integration-failed", "a trajectory left the drivers' span at the solution.");
  for (Object& ob : objects) residuals(ob);
  build();
  std::vector<double> cov;
  std::vector<double> scratch(rhs);
  const bool haveCov = cholesky_solve(NM, scratch, n, &cov);

  std::vector<double> sigmas;
  if (haveCov)
    for (int k = 0; k < nTheta; ++k) sigmas.push_back(std::sqrt(cov[size_t(k) * n + k]));
  fb::FlatBufferBuilder b(1 << 16);
  // Identifiability: the mean level of each altitude node and its formal
  // sigma; the correlation of the overall mean level with the mean ln B.
  std::vector<fb::Offset<dclLevel>> level;
  double varT = 0, varB = 0, covTB = 0;
  for (int a = 0; a < P; ++a) {
    double m = 0, var = 0;
    for (int j = 0; j < M; ++j) m += corr.v[j * P + a] / M;
    if (haveCov)
      for (int j = 0; j < M; ++j)
        for (int k = 0; k < M; ++k) var += cov[size_t(j * P + a) * n + (k * P + a)] / (double(M) * M);
    level.push_back(CreatedclLevel(b, P == 1 ? kNaN : corr.alt[a], m, haveCov ? std::sqrt(var) : kNaN));
  }
  // The mean ln B is weighted by each object's precision (1 / its ln B
  // variance), so that an object whose B the data cannot resolve does not
  // dominate it.
  if (haveCov) {
    std::vector<double> wB(N, 0.0);
    double sumW = 0;
    for (int i = 0; i < N; ++i) { wB[i] = 1.0 / std::max(1e-300, cov[size_t(nTheta + i) * n + (nTheta + i)]); sumW += wB[i]; }
    for (double& w : wB) w /= sumW;
    for (int u = 0; u < nTheta; ++u)
      for (int v = 0; v < nTheta; ++v) varT += cov[size_t(u) * n + v] / (double(nTheta) * nTheta);
    for (int i = 0; i < N; ++i)
      for (int k = 0; k < N; ++k) varB += wB[i] * wB[k] * cov[size_t(nTheta + i) * n + (nTheta + k)];
    for (int u = 0; u < nTheta; ++u)
      for (int i = 0; i < N; ++i) covTB += cov[size_t(u) * n + (nTheta + i)] * wB[i] / double(nTheta);
  }
  std::vector<fb::Offset<dclObject>> objs;
  for (int i = 0; i < N; ++i) {
    Object& ob = objects[i];
    double s = 0, cnt = 0, obsDecay = 0, modelDecay = 0;
    long used = 0, inChains = 0;
    for (size_t c = 0; c < ob.chains.size(); ++c) {
      obsDecay += (ob.sets[ob.chains[c].back()].aKm - ob.sets[ob.chains[c].front()].aKm) * 1000.0;
      for (const Segment& sg : ob.segments[c]) modelDecay += std::exp(ob.lnB) * sg.D;
      inChains += long(ob.chains[c].size());
    }
    std::vector<uint8_t> setUsed(ob.sets.size(), 0);
    for (size_t k = 0; k < ob.sets.size(); ++k) {
      if (std::isfinite(ob.residualM[k]) && ob.use[k]) { s += ob.residualM[k] * ob.residualM[k]; ++cnt; ++used; }
      setUsed[k] = std::isfinite(ob.residualM[k]) && ob.use[k] != 0;
    }
    const auto id = b.CreateString(ob.id);
    const auto refused = refusals(b, ob.refused);
    const SetColumns sc = set_columns(b, ob);
    fb::Offset<fb::Vector<double>> vRes;
    fb::Offset<fb::Vector<uint8_t>> vUsed;
    if (wantResiduals) {
      vRes = doubles(b, ob.residualM);
      vUsed = b.CreateVector(setUsed);
    }
    dclFitStatisticsBuilder fs(b);
    fs.add_OBSERVATIONS(uint32_t(inChains));
    fs.add_USED(uint32_t(used));
    fs.add_PREFIT_RMS(prefit[i]);
    fs.add_POSTFIT_RMS(cnt > 0 ? std::sqrt(s / cnt) : 0.0);
    const auto fit = fs.Finish();
    dclObjectBuilder o(b);
    o.add_ID(id);
    o.add_BALLISTIC_COEFFICIENT_M2_KG(std::exp(ob.lnB));
    o.add_LN_B_PRIOR_MEAN(ob.lnBPrior);
    o.add_LN_B_PRIOR_SIGMA(ob.lnBSigma);
    o.add_OK(true);
    o.add_REFUSED(refused);
    o.add_SET_TIME_MS(sc.time);
    o.add_SET_MEAN_SEMI_MAJOR_AXIS_KM(sc.a);
    o.add_SET_PERIGEE_HEIGHT_KM(sc.perigee);
    o.add_SET_ECCENTRICITY(sc.ecc);
    if (wantResiduals) {
      o.add_SET_RESIDUAL_M(vRes);
      o.add_SET_USED(vUsed);
    }
    o.add_MEAN_ALTITUDE_KM(mean_altitude(ob));
    o.add_LN_B(ob.lnB);
    o.add_LN_B_SIGMA(haveCov ? std::sqrt(cov[size_t(nTheta + i) * n + (nTheta + i)]) : kNaN);
    o.add_RESIDUAL_SCALE_M(ob.sigmaM);
    o.add_CHAINS(uint32_t(ob.chains.size()));
    o.add_SETS_IN_CHAINS(uint32_t(inChains));
    o.add_FIRST_MS(ms_of_mjd(ob.sets[ob.chains.front().front()].mjd));
    o.add_LAST_MS(ms_of_mjd(ob.sets[ob.chains.back().back()].mjd));
    o.add_OBSERVED_DECAY_M(obsDecay);
    o.add_MODEL_DECAY_M(modelDecay);
    o.add_FIT(fit);
    objs.push_back(o.Finish());
  }
  for (const Skipped& k : skipped) {
    const auto id = b.CreateString(k.id);
    const auto reason = b.CreateString(k.reason);
    const auto refused = refusals(b, k.refused);
    dclObjectBuilder o(b);
    o.add_ID(id);
    o.add_OK(k.counted);
    o.add_SKIPPED_REASON(reason);
    o.add_REFUSED(refused);
    if (k.counted) o.add_SETS_IN_CHAINS(uint32_t(k.sets));
    objs.push_back(o.Finish());
  }
  std::vector<fb::Offset<dclIteration>> hist;
  for (const Step& h : history) hist.push_back(CreatedclIteration(b, uint32_t(h.iteration), h.chi2, uint32_t(h.observations), h.big, h.bigB, h.bigA));
  const auto vObjs = b.CreateVector(objs);
  const auto vLevel = b.CreateVector(level);
  const auto vHist = b.CreateVector(hist);
  const auto corrOut = corr.record(b, haveCov ? &sigmas : nullptr);
  dclFitStatisticsBuilder fs(b);
  fs.add_ITERATIONS(uint32_t(iterations));
  fs.add_CONVERGED(converged);
  fs.add_OBSERVATIONS(uint32_t(observations));
  fs.add_USED(uint32_t(observations));
  fs.add_PARAMETERS(uint32_t(n));
  fs.add_CHI_SQUARE(chi2);
  const auto fit = fs.Finish();
  const auto alts = doubles(b, corr.alt);
  dclSettingsBuilder sb(b);
  sb.add_FROM_MS(settings->FROM_MS());
  sb.add_TO_MS(settings->TO_MS());
  sb.add_MAX_ITERATIONS(uint32_t(maxIt));
  sb.add_EDIT_SIGMA(edit);
  sb.add_NODE_STEP_S(stepH * 3600.0);
  sb.add_NODE_ALTITUDES_KM(alts);
  sb.add_RANDOM_WALK_K_PER_SQRT_DAY(rw);
  sb.add_MEAN_LEVEL_K(meanK);
  sb.add_ALTITUDE_DIFFERENCE_K(diffK);
  sb.add_STEP_S(stepS);
  sb.add_MAX_GAP_S(maxGap * 86400.0);
  sb.add_RESIDUAL_FLOOR_M(floorM);
  sb.add_REWEIGHT_ITERATIONS(uint32_t(reweight));
  sb.add_TOLERANCE_K(tolK);
  sb.add_TOLERANCE_LN_B(tolLnB);
  sb.add_TOLERANCE_OFFSET_M(tolA0);
  sb.add_MIN_SETS(uint32_t(minSets));
  sb.add_WANT_RESIDUALS(wantResiduals);
  const auto set = sb.Finish();
  const auto atm = atmosphere_record(b, false);
  DCLBuilder d(b);
  d.add_PRODUCT(dclProduct::DecayCalibration);
  d.add_ATMOSPHERE(atm);
  d.add_SETTINGS(set);
  d.add_CORRECTION(corrOut);
  d.add_STATUS(converged ? dclStatus::Solved : dclStatus::NotConverged);
  d.add_OBJECTS(vObjs);
  d.add_FIT(fit);
  d.add_LEVELS(vLevel);
  d.add_HISTORY(vHist);
  d.add_LEVEL_LN_B_CORRELATION(haveCov && varT > 0 && varB > 0 ? covTB / std::sqrt(varT * varB) : kNaN);
  d.add_MEAN_LEVEL_SIGMA_K(haveCov ? std::sqrt(varT) : kNaN);
  return emit("calibration", b, d.Finish());
}

// ── Orbital energy and drag work ─────────────────────────────────────────────
//
// energy: the specific mechanical energy of a state in axes turning with the
// Earth, the Jacobi integral of the geopotential,
//   C = 1/2 |v|^2 + U(r_ef) - omega . (r x v),
// with U the EGM2008 potential energy to a given degree and order (the
// central term -GM/r with the caller's GM, as propagator/ffm takes
// GRAVITATIONAL_PARAMETER, and the harmonics n >= 2 with EGM2008's own GM
// and radius, as ffm reads its embedded field, lib/egm2008_data.h), r_ef the
// position in IAU 2006/2000A Earth-fixed axes (ERFA: CIO-based, Earth
// rotation angle from UT1 = UTC + dut1, polar motion when given) and omega
// the Earth's rotation vector in GCRF. A static field in uniformly rotating
// axes conserves C along any orbit that only the geopotential acts on, and
//   dC/dt = a . v_r,   v_r = v - omega x r,
// for every other acceleration a (drag, thrust, radiation pressure, the
// third bodies and tides). The gradient is returned in GCRF:
//   dC/dr = grad U + omega x v,   dC/dv = v_r
// with grad U by central differences of U in Earth-fixed axes (0.5 m).
//
// drag_work: the drag power per unit Cd*A/m along the same states,
//   p = -1/2 rho |v_r|^3,
// with rho the JB2008 density (the correction, when given) at the state's
// WGS84 geodetic point, and the work between consecutive states by the
// trapezoid rule; the energy that a drag-only change of C would show.
namespace {

constexpr double kEgmRadius = 6378136.3;      // m, EGM2008
constexpr double kEgmGm = 3.986004415e14;     // m^3/s^2, EGM2008 (TT-compatible)
constexpr double kArcsec = kPi / 648000.0;
constexpr int kMaxGeopotentialDegree = 70;
double gEgmC[kMaxGeopotentialDegree + 1][kMaxGeopotentialDegree + 1];
double gEgmS[kMaxGeopotentialDegree + 1][kMaxGeopotentialDegree + 1];
double gLegendre[kMaxGeopotentialDegree + 1][kMaxGeopotentialDegree + 1];
bool gEgmLoaded = false;
void load_egm() {
  if (gEgmLoaded) return;
  for (const auto& c : astro::EGM2008Data::COEFFICIENTS) {
    gEgmC[c.n][c.m] = c.Cnm;
    gEgmS[c.n][c.m] = c.Snm;
  }
  gEgmLoaded = true;
}

// Potential energy (J/kg) at an Earth-fixed position (m), degree N, order M.
double geopotential(const double x[3], int N, int M, double gm) {
  load_egm();
  const double rxy = std::hypot(x[0], x[1]), r = std::hypot(rxy, x[2]);
  const double s = x[2] / r, c = rxy / r, lon = std::atan2(x[1], x[0]);
  // Fully normalised associated Legendre functions of sin(latitude), forward column recursion.
  gLegendre[0][0] = 1.0;
  gLegendre[1][0] = std::sqrt(3.0) * s;
  gLegendre[1][1] = std::sqrt(3.0) * c;
  for (int n = 2; n <= N; ++n) gLegendre[n][n] = std::sqrt((2.0 * n + 1.0) / (2.0 * n)) * c * gLegendre[n - 1][n - 1];
  for (int m = 0; m < N; ++m) {
    if (m >= 1) gLegendre[m + 1][m] = std::sqrt(2.0 * m + 3.0) * s * gLegendre[m][m];
    for (int n = m + 2; n <= N; ++n) {
      const double d = double(n) * n - double(m) * m;
      const double a = std::sqrt((4.0 * n * n - 1.0) / d);
      const double b = std::sqrt((2.0 * n + 1.0) * (n + m - 1.0) * (n - m - 1.0) / ((2.0 * n - 3.0) * d));
      gLegendre[n][m] = a * s * gLegendre[n - 1][m] - b * gLegendre[n - 2][m];
    }
  }
  double cm[kMaxGeopotentialDegree + 2], sm[kMaxGeopotentialDegree + 2];
  cm[0] = 1.0; sm[0] = 0.0; cm[1] = std::cos(lon); sm[1] = std::sin(lon);
  for (int m = 2; m <= N; ++m) {
    cm[m] = 2.0 * cm[1] * cm[m - 1] - cm[m - 2];
    sm[m] = 2.0 * cm[1] * sm[m - 1] - sm[m - 2];
  }
  const double ratio = kEgmRadius / r;
  double power = ratio, sum = 0.0;
  for (int n = 2; n <= N; ++n) {
    power *= ratio;
    double inner = 0.0;
    for (int m = 0; m <= std::min(n, M); ++m) inner += gLegendre[n][m] * (gEgmC[n][m] * cm[m] + gEgmS[n][m] * sm[m]);
    sum += power * inner;
  }
  return -gm / r - kEgmGm / r * sum;
}

// GCRF -> Earth-fixed rotation (IAU 2006/2000A, CIO based) with the celestial-to-intermediate matrix held for an hour of TT.
class EarthOrientation {
 public:
  void matrix(double mjdUtc, double dut1Seconds, double xpArcsec, double ypArcsec, double rc2t[3][3]) {
    double tai1 = 0, tai2 = 0, tt1 = 0, tt2 = 0;
    eraUtctai(2400000.5, mjdUtc, &tai1, &tai2);
    eraTaitt(tai1, tai2, &tt1, &tt2);
    const double ttHour = std::floor(((tt1 - 2400000.5) + tt2) * 24.0);
    if (ttHour != cachedHour) {
      eraC2i06a(2400000.5, ttHour / 24.0, rc2i);
      cachedHour = ttHour;
    }
    const double era = eraEra00(2400000.5, mjdUtc + dut1Seconds / 86400.0);
    double rpom[3][3];
    eraPom00(xpArcsec * kArcsec, ypArcsec * kArcsec, eraSp00(tt1, tt2), rpom);
    eraC2tcio(rc2i, era, rpom, rc2t);
  }

 private:
  double cachedHour = std::numeric_limits<double>::quiet_NaN();
  double rc2i[3][3] = {};
};

// One request state: UTC MJD, GCRF position (m) and velocity (m/s), optional dut1 (s) and polar motion (arcsec).
struct OrbitalState {
  double mjd = 0, r[3] = {}, v[3] = {}, dut1 = 0, xp = 0, yp = 0;
};
// The states of STATES: its $OEM ephemeris block (GCRF, km and km/s), either EPHEMERIS_DATA_LINES (each with its EPOCH)
// or the compact EPHEMERIS_DATA (STATE_VECTOR_SIZE values per state at START_TIME + i STEP_SIZE), with DUT1_S,
// POLAR_MOTION_X_ARCSEC and POLAR_MOTION_Y_ARCSEC parallel to them (empty = 0).
std::string load_states(const DCL* request, std::vector<OrbitalState>& out) {
  const dclStates* states = request->STATES();
  const ephemerisDataBlock* block = states ? states->EPHEMERIS() : nullptr;
  const char* missing = "STATES needs an EPHEMERIS block with at least one state (GCRF, km and km/s).";
  if (!block) return missing;
  if (size_of(block->EPHEMERIS_DATA_LINES()) != 0) {
    for (const ephemerisDataLine* line : *block->EPHEMERIS_DATA_LINES()) {
      OrbitalState o;
      if (!mjd_of_iso(line->EPOCH(), o.mjd)) return "each ephemeris line needs an EPOCH (ISO 8601 UTC).";
      const double r[3] = {line->X(), line->Y(), line->Z()}, v[3] = {line->X_DOT(), line->Y_DOT(), line->Z_DOT()};
      for (int k = 0; k < 3; ++k) { o.r[k] = r[k] * 1000.0; o.v[k] = v[k] * 1000.0; }
      out.push_back(o);
    }
  } else if (size_of(block->EPHEMERIS_DATA()) != 0) {
    const int stride = block->STATE_VECTOR_SIZE();
    const auto* data = block->EPHEMERIS_DATA();
    double start = 0;
    if ((stride != 6 && stride != 9) || data->size() % stride != 0) return "EPHEMERIS_DATA needs STATE_VECTOR_SIZE (6 or 9) values per state.";
    if (!mjd_of_iso(block->START_TIME(), start)) return "a compact ephemeris needs START_TIME (ISO 8601 UTC).";
    for (size_t i = 0; i < data->size() / stride; ++i) {
      OrbitalState o;
      o.mjd = start + double(i) * block->STEP_SIZE() / 86400.0;
      for (int k = 0; k < 3; ++k) { o.r[k] = data->Get(uint32_t(i * stride + k)) * 1000.0; o.v[k] = data->Get(uint32_t(i * stride + 3 + k)) * 1000.0; }
      out.push_back(o);
    }
  }
  if (out.empty()) return missing;
  const auto column = [&](const fb::Vector<double>* v, double OrbitalState::*member, const char* name) -> std::string {
    if (size_of(v) == 0) return "";
    if (v->size() != out.size()) return std::string("STATES ") + name + " must have one value per state (or none).";
    for (size_t i = 0; i < out.size(); ++i) out[i].*member = v->Get(uint32_t(i));
    return "";
  };
  std::string e = column(states->DUT1_S(), &OrbitalState::dut1, "DUT1_S");
  if (e.empty()) e = column(states->POLAR_MOTION_X_ARCSEC(), &OrbitalState::xp, "POLAR_MOTION_X_ARCSEC");
  if (e.empty()) e = column(states->POLAR_MOTION_Y_ARCSEC(), &OrbitalState::yp, "POLAR_MOTION_Y_ARCSEC");
  return e;
}

void cross(const double a[3], const double b[3], double c[3]) {
  c[0] = a[1] * b[2] - a[2] * b[1];
  c[1] = a[2] * b[0] - a[0] * b[2];
  c[2] = a[0] * b[1] - a[1] * b[0];
}
double dot(const double a[3], const double b[3]) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }

// The Earth-fixed position, the rotation vector in GCRF and the relative velocity of one state.
struct Frame {
  double rc2t[3][3] = {}, xe[3] = {}, omega[3] = {}, vr[3] = {};
  bool ok = false;
};
Frame frame_of(EarthOrientation& eo, const OrbitalState& s, double omegaEarth) {
  Frame f;
  const double r2 = dot(s.r, s.r);
  if (!finite(s.mjd) || !finite(r2) || !(r2 > 6.0e6 * 6.0e6)) return f;
  eo.matrix(s.mjd, s.dut1, s.xp, s.yp, f.rc2t);
  for (int i = 0; i < 3; ++i) f.xe[i] = f.rc2t[i][0] * s.r[0] + f.rc2t[i][1] * s.r[1] + f.rc2t[i][2] * s.r[2];
  for (int j = 0; j < 3; ++j) f.omega[j] = f.rc2t[2][j] * omegaEarth;  // R^T (0, 0, omega)
  double wr[3];
  cross(f.omega, s.r, wr);
  for (int k = 0; k < 3; ++k) f.vr[k] = s.v[k] - wr[k];
  f.ok = true;
  return f;
}

// Shared EGM2008 Jacobi energy and gradient for the public energy method and
// E13 energy-arc calibration. Keep the physical computation in one place.
struct EnergyPoint { double value=0,kinetic=0,potential=0,rotation=0,speed=0,lat=0,lon=0,alt=0,gradient[6]={}; bool ok=false; };
EnergyPoint orbital_energy(EarthOrientation& eo,const OrbitalState& s,int degree,int order,double gm,double omegaEarth,bool wantGradient) {
  EnergyPoint out;const Frame f=frame_of(eo,s,omegaEarth);if(!f.ok)return out;
  out.potential=geopotential(f.xe,degree,order,gm);
  double rv[3];cross(s.r,s.v,rv);out.kinetic=0.5*dot(s.v,s.v);out.rotation=dot(f.omega,rv);
  out.value=out.kinetic+out.potential-out.rotation;out.speed=std::sqrt(dot(f.vr,f.vr));
  double elong=0,phi=0,height=0,xe[3]={f.xe[0],f.xe[1],f.xe[2]};eraGc2gd(1,xe,&elong,&phi,&height);
  out.lat=phi/kDeg;out.lon=elong/kDeg;out.alt=height/1000.0;
  if(wantGradient){
    constexpr double h=0.5;double g[3];
    for(int k=0;k<3;++k){double up[3]={f.xe[0],f.xe[1],f.xe[2]},dn[3]={f.xe[0],f.xe[1],f.xe[2]};up[k]+=h;dn[k]-=h;g[k]=(geopotential(up,degree,order,gm)-geopotential(dn,degree,order,gm))/(2.0*h);}
    double gradU[3],wv[3];for(int j=0;j<3;++j)gradU[j]=f.rc2t[0][j]*g[0]+f.rc2t[1][j]*g[1]+f.rc2t[2][j]*g[2];
    cross(f.omega,s.v,wv);for(int k=0;k<3;++k){out.gradient[k]=gradU[k]+wv[k];out.gradient[k+3]=f.vr[k];}
  }
  out.ok=true;return out;
}

}  // namespace

// energy: STATES (EPHEMERIS, DUT1_S?, POLAR_MOTION_*?), GRAVITY_DEGREE (2-70; 0 = 36), GRAVITY_ORDER (0 = the degree),
// GM_M3_S2 (0 = 3.986004418e14), EARTH_ROTATION_RAD_S (0 = 7.292115e-5), SETTINGS WANT_GRADIENT -> STATES ENERGY_J_KG,
// KINETIC_J_KG, POTENTIAL_J_KG, ROTATIONAL_J_KG, RELATIVE_SPEED_M_S, LATITUDE_DEG, LONGITUDE_DEG, ALTITUDE_KM,
// ENERGY_GRADIENT [dC/dr (3), dC/dv (3)] per state (with WANT_GRADIENT), REFUSED (NaN in every column of a refused state).
extern "C" int energy() {
  std::string e;
  const DCL* request = dcl_request(e);
  if (!request) return fail("invalid-request", e);
  std::vector<OrbitalState> states;
  e = load_states(request, states);
  if (!e.empty()) return fail("invalid-request", e);
  const int degree = request->GRAVITY_DEGREE() != 0 ? int(request->GRAVITY_DEGREE()) : 36;
  const int order = request->GRAVITY_ORDER() != 0 ? int(request->GRAVITY_ORDER()) : degree;
  if (degree < 2 || degree > kMaxGeopotentialDegree || order < 0 || order > degree)
    return fail("invalid-request", "GRAVITY_DEGREE (the field degree) must be 2-70 and GRAVITY_ORDER 0-degree.");
  if (request->GRAVITY_FIELD() && request->GRAVITY_FIELD()->size() != 0 && request->GRAVITY_FIELD()->str() != "EGM2008")
    return fail("invalid-request", "GRAVITY_FIELD must be EGM2008 (or empty).");
  const double gm = request->GM_M3_S2() != 0 ? request->GM_M3_S2() : kMu;
  const double omegaEarth = request->EARTH_ROTATION_RAD_S() != 0 ? request->EARTH_ROTATION_RAD_S() : kOmegaEarth;
  if (!positive(gm) || !positive(omegaEarth)) return fail("invalid-request", "GM_M3_S2 and EARTH_ROTATION_RAD_S must be positive.");
  const bool wantGradient = settings_of(request)->WANT_GRADIENT();
  EarthOrientation eo;
  std::vector<double> energyJ, kinetic, potential, rotation, speed, lat, lon, alt, gradient;
  std::vector<uint32_t> refused;
  for (size_t i = 0; i < states.size(); ++i) {
    const OrbitalState& s = states[i];
    const auto point=orbital_energy(eo,s,degree,order,gm,omegaEarth,wantGradient);
    if(!point.ok){
      refused.push_back(uint32_t(i));
      for(std::vector<double>* a:{&energyJ,&kinetic,&potential,&rotation,&speed,&lat,&lon,&alt})a->push_back(kNaN);
      if(wantGradient)gradient.insert(gradient.end(),6,kNaN);
      continue;
    }
    energyJ.push_back(point.value);kinetic.push_back(point.kinetic);potential.push_back(point.potential);rotation.push_back(point.rotation);
    speed.push_back(point.speed);lat.push_back(point.lat);lon.push_back(point.lon);alt.push_back(point.alt);
    if(wantGradient)gradient.insert(gradient.end(),point.gradient,point.gradient+6);
  }
  fb::FlatBufferBuilder b(1024 + states.size() * 120);
  const auto vE = doubles(b, energyJ), vK = doubles(b, kinetic), vU = doubles(b, potential), vR = doubles(b, rotation);
  const auto vS = doubles(b, speed), vLat = doubles(b, lat), vLon = doubles(b, lon), vAlt = doubles(b, alt);
  const auto vRef = indices(b, refused);
  const fb::Offset<fb::Vector<double>> vG = wantGradient ? doubles(b, gradient) : fb::Offset<fb::Vector<double>>();
  dclStatesBuilder sb(b);
  sb.add_ENERGY_J_KG(vE);
  sb.add_KINETIC_J_KG(vK);
  sb.add_POTENTIAL_J_KG(vU);
  sb.add_ROTATIONAL_J_KG(vR);
  if (wantGradient) sb.add_ENERGY_GRADIENT(vG);
  sb.add_RELATIVE_SPEED_M_S(vS);
  sb.add_LATITUDE_DEG(vLat);
  sb.add_LONGITUDE_DEG(vLon);
  sb.add_ALTITUDE_KM(vAlt);
  sb.add_REFUSED(vRef);
  const auto statesOut = sb.Finish();
  dclSettingsBuilder st(b);
  st.add_WANT_GRADIENT(wantGradient);
  const auto set = st.Finish();
  const auto field = b.CreateString("EGM2008");
  DCLBuilder d(b);
  d.add_PRODUCT(dclProduct::OrbitalEnergy);
  d.add_GRAVITY_FIELD(field);
  d.add_GRAVITY_DEGREE(uint16_t(degree));
  d.add_GRAVITY_ORDER(uint16_t(order));
  d.add_GM_M3_S2(gm);
  d.add_EARTH_ROTATION_RAD_S(omegaEarth);
  d.add_SETTINGS(set);
  d.add_STATUS(dclStatus::Solved);
  d.add_STATES(statesOut);
  return emit("result", b, d.Finish());
}

// drag_work: STATES, the drivers of ATMOSPHERE (JB2008_DRIVERS, or SPACE_WEATHER for NRLMSIS00E), CORRECTION? (JB2008
// only), BALLISTIC_COEFFICIENT_M2_KG (Cd*A/m; 0 = 1), EARTH_ROTATION_RAD_S -> STATES DENSITY_KG_M3, RELATIVE_SPEED_M_S,
// DRAG_POWER_W_KG (= -B rho |v_r|^3 / 2), DRAG_WORK_J_KG between consecutive states (trapezoid), CUMULATIVE_DRAG_WORK_J_KG,
// REFUSED.
extern "C" int drag_work() {
  std::string e;
  const DCL* request = dcl_request(e);
  if (!request) return fail("invalid-request", e);
  std::vector<OrbitalState> states;
  e = load_states(request, states);
  if (!e.empty()) return fail("invalid-request", e);
  bool msis = false;
  e = atmosphere_of(request, msis);
  if (!e.empty()) return fail("invalid-request", e);
  Jb2008Table table;
  Nrlmsise00Table msisTable;
  const bool corrected = request->CORRECTION() && request->CORRECTION()->FORM() != dclCorrectionForm::None;
  if (msis) {
    if (corrected) return fail("invalid-correction", "ATMOSPHERE NRLMSIS00E has no temperature correction.");
    e = msisTable.add(request->SPACE_WEATHER());
  } else {
    e = table.add(request->JB2008_DRIVERS());
  }
  if (!e.empty()) return fail("invalid-request", e);
  Correction correction;
  e = correction.load(request->CORRECTION());
  if (!e.empty()) return fail("invalid-correction", e);
  const double B = request->BALLISTIC_COEFFICIENT_M2_KG() != 0 ? request->BALLISTIC_COEFFICIENT_M2_KG() : 1.0;
  const double omegaEarth = request->EARTH_ROTATION_RAD_S() != 0 ? request->EARTH_ROTATION_RAD_S() : kOmegaEarth;
  if (!std::isfinite(B) || !positive(omegaEarth)) return fail("invalid-request", "BALLISTIC_COEFFICIENT_M2_KG and EARTH_ROTATION_RAD_S must be finite and positive.");
  EarthOrientation eo;
  SunEarthFixed sun;
  const size_t n = states.size();
  std::vector<double> rho(n, std::numeric_limits<double>::quiet_NaN()), speed(rho), power(rho);
  std::vector<uint32_t> refused;
  for (size_t i = 0; i < n; ++i) {
    const OrbitalState& s = states[i];
    const Frame f = frame_of(eo, s, omegaEarth);
    Point p;
    if (f.ok) {
      double xe[3] = {f.xe[0], f.xe[1], f.xe[2]}, elong = 0, phi = 0, height = 0;
      eraGc2gd(1, xe, &elong, &phi, &height);
      p.mjd = s.mjd;
      p.lat = phi;
      p.lon = std::remainder(elong, 2 * kPi);
      p.altM = height;
      if (msis) {
        if (p.altM >= 90e3 && p.altM <= 1000e3 && msisTable.at(p.mjd, p.f107, p.f107a, p.ap)) p.ok = true;
      } else if (p.altM >= 90e3 && p.altM <= 2500e3 && table.at(p.mjd, p.in)) {
        sun.at(p.mjd, p.sunLon, p.sunLat);
        p.ok = true;
      }
    }
    if (!p.ok) { refused.push_back(uint32_t(i)); continue; }
    speed[i] = std::sqrt(dot(f.vr, f.vr));
    rho[i] = msis ? msis_density(p.mjd, p.lat, p.lon, p.altM, p.f107, p.f107a, p.ap) : rho_at(p, correction.at(p));
    power[i] = -0.5 * B * rho[i] * speed[i] * speed[i] * speed[i];
  }
  std::vector<double> work, cumulative;
  double total = 0.0;
  cumulative.push_back(0.0);
  for (size_t i = 0; i + 1 < n; ++i) {
    const double dt = (states[i + 1].mjd - states[i].mjd) * 86400.0;
    const bool both = std::isfinite(power[i]) && std::isfinite(power[i + 1]);
    work.push_back(both ? 0.5 * (power[i] + power[i + 1]) * dt : kNaN);
    if (both) total += 0.5 * (power[i] + power[i + 1]) * dt;
    cumulative.push_back(total);
  }
  fb::FlatBufferBuilder b(1024 + n * 64);
  const auto vRho = doubles(b, rho), vSpeed = doubles(b, speed), vPower = doubles(b, power), vWork = doubles(b, work);
  const auto vCum = doubles(b, cumulative);
  const auto vRef = indices(b, refused);
  dclStatesBuilder sb(b);
  sb.add_RELATIVE_SPEED_M_S(vSpeed);
  sb.add_DENSITY_KG_M3(vRho);
  sb.add_DRAG_POWER_W_KG(vPower);
  sb.add_DRAG_WORK_J_KG(vWork);
  sb.add_CUMULATIVE_DRAG_WORK_J_KG(vCum);
  sb.add_REFUSED(vRef);
  const auto statesOut = sb.Finish();
  const auto atm = atmosphere_record(b, msis);
  const auto corr = correction.record(b);
  DCLBuilder d(b);
  d.add_PRODUCT(dclProduct::DragWork);
  d.add_ATMOSPHERE(atm);
  d.add_EARTH_ROTATION_RAD_S(omegaEarth);
  d.add_BALLISTIC_COEFFICIENT_M2_KG(B);
  if (correction.present) d.add_CORRECTION(corr);
  d.add_STATUS(dclStatus::Solved);
  d.add_STATES(statesOut);
  return emit("result", b, d.Finish());
}

namespace {
// The method parameters of this run: the flow's typed config, all off by default.
bool publication_of(open_dca::Publication& p,std::string& error){
  const sdm_piv::Config config=sdm_piv::get_config();
  if(!config.ok()){error="the flow config could not be read: "+std::string(config.error_message());return false;}
  p.lagHours=config.number("open_dca_lag_hours",0);p.noiseSigma=config.number("open_dca_noise_sigma",0);p.shrinkWindowHours=config.number("open_dca_shrink_window_hours",0);
  if(!(p.lagHours>=0&&p.lagHours<=48)){error="open_dca_lag_hours must lie in 0..48.";return false;}
  if(!(p.noiseSigma>=0&&p.noiseSigma<=1&&p.shrinkWindowHours>=0&&p.shrinkWindowHours<=720)||(p.noiseSigma>0)!=(p.shrinkWindowHours>0)){error="open_dca_noise_sigma (0..1) and open_dca_shrink_window_hours (0..720) are set together or not at all.";return false;}
  return true;
}
// The method a record says it used, by value.
std::string lineage_of(const open_dca::Publication& p){
  char lag[32],shrink[64]="shrink-off";std::snprintf(lag,sizeof(lag),"lag%gh",p.lagHours);
  if(p.noiseSigma>0)std::snprintf(shrink,sizeof(shrink),"shrink-sigma%g-window%gh",p.noiseSigma,p.shrinkWindowHours);
  return std::string("E13/OAE-3e0ff003; daily24h; rw0.005; smooth0.05; public-at-issue; history30d; hold48h; ")+lag+"; "+shrink+"; mean-zero-supported";
}
}
// E13's exploratory NRLMSISE-00 form (PLAN S3), frozen R1/R2 solver. This
// method deliberately emits no OBJECTS, STATES, drivers or private arc fits.
extern "C" int calibrate_log_density() {
  std::string error;
  const DCL* request=dcl_request(error);
  if(!request)return fail("invalid-request",error);
  if(!request->ATMOSPHERE()||request->ATMOSPHERE()->MODEL()!=AtmosphericModelFamily::NRLMSIS00E || request->CREATED_AT_MS()<=0)
    return fail("invalid-request","NRLMSISE-00 and an explicit UTC issue time are required.");
  open_dca::Publication publication;
  if(!publication_of(publication,error))return fail("invalid-config",error);
  std::vector<open_dca::Arc> arcs;
  if(request->OBJECTS())for(const auto* o:*request->OBJECTS()){
    if(!o->OK())continue;
    const double hours=double(o->LAST_MS()-o->FIRST_MS())/open_dca::hour;
    if(!o->ID()||hours<20||hours>28||!positive(o->BALLISTIC_COEFFICIENT_M2_KG())||!std::isfinite(o->LN_B())||!std::isfinite(o->LN_B_SIGMA())||o->LN_B_SIGMA()<0||o->LN_B_SIGMA()>0.5)
      return fail("invalid-arc","Accepted arcs must be finite 20–28 hour NRLMSISE-00 energy fits with positive B and sigma(ln B) <= 0.5.");
    arcs.push_back({o->ID()->str(),double(o->FIRST_MS()),double(o->LAST_MS()),o->LN_B()});
  }
  open_dca::Result result;
  if(!open_dca::solve(arcs,double(request->CREATED_AT_MS()),result,error))return fail("insufficient-fleet",error);
  if(!result.converged)return fail("not-converged","E13 common-mode solve did not meet its frozen tolerance in 60 iterations.");
  size_t first=0,last=result.times.size()-1;
  while(!result.supported[first])++first;
  while(!result.supported[last])--last;
  if(double(request->CREATED_AT_MS())-result.times[last]>48*open_dca::hour)
    return fail("stale-fleet","Last supported solve is more than 48 hours before issue; publication refused.");
  const auto values=open_dca::shrunk(result,publication);
  const double lag=publication.lagHours*open_dca::hour;
  DCLT out;
  out.ID="open-dca-nrlmsise00-"+std::to_string(request->CREATED_AT_MS());
  out.CREATED_AT_MS=request->CREATED_AT_MS();out.PRODUCT=dclProduct::DensityCalibration;out.STATUS=dclStatus::Solved;
  out.ATMOSPHERE=std::make_unique<ATMT>();out.ATMOSPHERE->MODEL=AtmosphericModelFamily::NRLMSIS00E;out.ATMOSPHERE->YEAR=2000;
  out.SETTINGS=std::make_unique<dclSettingsT>();out.SETTINGS->FROM_MS=int64_t(result.times[first]-lag);out.SETTINGS->TO_MS=int64_t(result.times[last]-lag);
  out.CORRECTION=std::make_unique<dclCorrectionT>();out.CORRECTION->FORM=dclCorrectionForm::LogDensityNodes;
  for(size_t i=first;i<=last;++i){out.CORRECTION->NODE_TIMES_MS.push_back(int64_t(result.times[i]-lag));out.CORRECTION->NODE_LOG_DENSITY_SCALE_DIMENSIONLESS.push_back(values[i]);}
  // Held past the last solve epoch: no fit, whatever its cutoff, meets a ramp the producer wrote.
  out.CORRECTION->NODE_TIMES_MS.push_back(int64_t(result.times[last]-lag+48*open_dca::hour));out.CORRECTION->NODE_LOG_DENSITY_SCALE_DIMENSIONLESS.push_back(values[last]);
  out.FIT=std::make_unique<dclFitStatisticsT>();out.FIT->ITERATIONS=result.iterations;out.FIT->CONVERGED=true;out.FIT->OBSERVATIONS=arcs.size();out.FIT->USED=result.arcs;out.FIT->PARAMETERS=last-first;
  double sum=0;for(double r:result.residuals)sum+=r*r;out.FIT->POSTFIT_RMS=std::sqrt(sum/result.residuals.size());
  out.PROVENANCE=std::make_unique<PVNT>();out.PROVENANCE->SOURCE_ID="open-dca-planet";out.PROVENANCE->SOURCE_KIND=pvnSourceKind::Ephemeris;
  out.PROVENANCE->ORIGINATOR="Derived aggregate from Planet Labs PBC orbital ephemerides, https://ephemerides.planet-labs.com/, copyright Planet Labs PBC, CC BY-NC 4.0. GFZ Kp/ap/F10.7: CC BY 4.0, Matzka et al. (2021), doi:10.1029/2020SW002641; NOAA SWPC: public domain.";
  out.PROVENANCE->PROVIDER_ID="open-dca";out.PROVENANCE->PRODUCER="density-calibration/0.7.0; E13 R1/R2/S3 NRLMSISE-00 exploratory method";
  out.PROVENANCE->LICENSE_CLASS=pvnLicenseClass::NonCommercial;out.PROVENANCE->LICENSE_ID="CC-BY-NC-4.0 (Planet inputs); CC-BY-4.0 (GFZ); public domain (NOAA SWPC)";
  out.PROVENANCE->LINEAGE=lineage_of(publication);
  if(request->PROVENANCE()&&request->PROVENANCE()->LINEAGE())out.PROVENANCE->LINEAGE+="; "+request->PROVENANCE()->LINEAGE()->str();
  fb::FlatBufferBuilder b;return emit("calibration",b,DCL::Pack(b,&out));
}

#include "open_dca_energy_arcs.hpp"
