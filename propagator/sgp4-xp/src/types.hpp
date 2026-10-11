// propagator/sgp4-xp: the types and the plain arithmetic the other headers share: dates, mean elements in the units
// of two-line element text and that text, and the records of a fit. Nothing here reaches the Space Force library,
// ERFA or an SDS record, so the signed OD node of flows/supplemental-omm compiles its calls to the fit engine
// against exactly these definitions.
#pragma once

#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

namespace sgp4xp {

constexpr double kPi = 3.14159265358979323846;
constexpr double kDegToRad = kPi / 180.0;
constexpr double kRadToDeg = 180.0 / kPi;
// WGS-72, the gravity model of SGP4's mean elements (and the OMM's GM).
constexpr double kMuKm3PerS2 = 398600.8;
constexpr double kSecondsPerDay = 86400.0;
constexpr double kEpochTickDays = 1.0e-8;  // the TLE epoch field: eight decimals of a day
constexpr double kEpochTickSeconds = 864.0e-6;

// ---------------------------------------------------------------------------------------------------------------
// Dates. A UTC instant is a day number (MJD) and the seconds into that day, every day 86400 s long: the convention
// of the TLE epoch and of SGP4's minutes since epoch. A fit whose arc holds a leap second is refused (module.cpp).
// ---------------------------------------------------------------------------------------------------------------
struct Instant {
  int64_t day = 0;     // Modified Julian Date number
  double seconds = 0;  // into the day, [0, 86400)
};

inline int64_t daysFromCivil(int64_t y, int64_t m, int64_t d) {  // days since 1970-01-01 (H. Hinnant)
  y -= m <= 2;
  const int64_t era = (y >= 0 ? y : y - 399) / 400;
  const int64_t yoe = y - era * 400;
  const int64_t doy = (153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1;
  const int64_t doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
  return era * 146097 + doe - 719468;
}
inline void civilFromDays(int64_t z, int64_t* y, int64_t* m, int64_t* d) {
  z += 719468;
  const int64_t era = (z >= 0 ? z : z - 146096) / 146097;
  const int64_t doe = z - era * 146097;
  const int64_t yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
  const int64_t doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
  const int64_t mp = (5 * doy + 2) / 153;
  *d = doy - (153 * mp + 2) / 5 + 1;
  *m = mp < 10 ? mp + 3 : mp - 9;
  *y = yoe + era * 400 + (*m <= 2);
}
constexpr int64_t kMjdOfUnixEpoch = 40587;

inline double secondsBetween(const Instant& a, const Instant& b) {  // a - b
  return static_cast<double>(a.day - b.day) * kSecondsPerDay + (a.seconds - b.seconds);
}
inline Instant addSeconds(Instant t, double seconds) {
  t.seconds += seconds;
  const double days = std::floor(t.seconds / kSecondsPerDay);
  t.day += static_cast<int64_t>(days);
  t.seconds -= days * kSecondsPerDay;
  if (t.seconds >= kSecondsPerDay) { t.seconds -= kSecondsPerDay; t.day += 1; }
  if (t.seconds < 0) t.seconds = 0;
  return t;
}

// ISO 8601 / CCSDS UTC: YYYY-MM-DDThh:mm:ss[.f...][Z] or YYYY-DDDThh:mm:ss[.f...][Z]. false when it is not one.
inline bool parseInstant(const std::string& text, Instant* out) {
  const char* p = text.c_str();
  auto digits = [&](int n, int64_t* v) {
    int64_t r = 0;
    for (int i = 0; i < n; ++i) {
      if (p[i] < '0' || p[i] > '9') return false;
      r = r * 10 + (p[i] - '0');
    }
    *v = r;
    p += n;
    return true;
  };
  int64_t year = 0, month = 0, dom = 0, doy = 0, hh = 0, mm = 0, ss = 0;
  if (!digits(4, &year) || *p != '-') return false;
  ++p;
  bool ordinal = false;
  {
    // Month (two digits) then '-', or day of year (three digits) then 'T'.
    const char* q = p;
    int n = 0;
    while (q[n] >= '0' && q[n] <= '9') ++n;
    if (n == 3) ordinal = true;
    else if (n != 2) return false;
  }
  if (ordinal) {
    if (!digits(3, &doy)) return false;
  } else {
    if (!digits(2, &month) || *p != '-') return false;
    ++p;
    if (!digits(2, &dom)) return false;
  }
  if (*p != 'T' && *p != ' ') return false;
  ++p;
  if (!digits(2, &hh) || *p != ':') return false;
  ++p;
  if (!digits(2, &mm) || *p != ':') return false;
  ++p;
  if (!digits(2, &ss)) return false;
  double fraction = 0.0;
  if (*p == '.') {
    ++p;
    double scale = 0.1;
    while (*p >= '0' && *p <= '9') { fraction += (*p - '0') * scale; scale *= 0.1; ++p; }
  }
  if (*p == 'Z') ++p;
  if (*p != '\0') return false;
  if (hh > 23 || mm > 59 || ss > 60) return false;
  int64_t days;
  if (ordinal) {
    if (doy < 1 || doy > 366) return false;
    days = daysFromCivil(year, 1, 1) + (doy - 1);
  } else {
    if (month < 1 || month > 12 || dom < 1 || dom > 31) return false;
    days = daysFromCivil(year, month, dom);
  }
  out->day = days + kMjdOfUnixEpoch;
  out->seconds = static_cast<double>(hh * 3600 + mm * 60 + ss) + fraction;
  return true;
}

inline std::string formatInstant(const Instant& t, int decimals = 6) {
  // Round to the requested decimals first so 59.9999996 s does not print as 60.000000.
  double scale = 1.0;
  for (int i = 0; i < decimals; ++i) scale *= 10.0;
  Instant r = addSeconds(t, 0.0);
  double ticks = std::floor(r.seconds * scale + 0.5);
  r.seconds = ticks / scale;
  if (r.seconds >= kSecondsPerDay) { r.seconds -= kSecondsPerDay; r.day += 1; }
  int64_t y, m, d;
  civilFromDays(r.day - kMjdOfUnixEpoch, &y, &m, &d);
  const int64_t whole = static_cast<int64_t>(r.seconds);
  const int64_t hh = whole / 3600, mm = (whole % 3600) / 60, ss = whole % 60;
  char buffer[64];
  const int64_t frac = static_cast<int64_t>(std::floor((r.seconds - static_cast<double>(whole)) * scale + 0.5));
  std::snprintf(buffer, sizeof buffer, "%04lld-%02lld-%02lldT%02lld:%02lld:%02lld.%0*lldZ", static_cast<long long>(y),
                static_cast<long long>(m), static_cast<long long>(d), static_cast<long long>(hh), static_cast<long long>(mm),
                static_cast<long long>(ss), decimals, static_cast<long long>(frac));
  return buffer;
}

// ---------------------------------------------------------------------------------------------------------------
// Mean elements in the units of the two-line element text, and that text.
// ---------------------------------------------------------------------------------------------------------------
struct Elements {
  bool xp = true;               // MEAN_ELEMENT_THEORY SGP4XP (BTERM, AGOM) or SGP4 (BSTAR)
  int64_t epochDay = 0;         // MJD number of the epoch
  int64_t epochTicks = 0;       // 1e-8 days into that day: the epoch is on the text's grid
  double meanMotion = 0;        // rev/day
  double eccentricity = 0;
  double inclination = 0;       // degrees
  double raan = 0;
  double argPerigee = 0;
  double meanAnomaly = 0;
  double drag = 0;              // BTERM, m^2/kg (XP) | BSTAR, 1/Earth radii (SGP4)
  double agom = 0;              // AGOM, m^2/kg (XP only)
  double meanMotionDot = 0;     // SGP4 only; rev/day^2
  double meanMotionDdot = 0;    // SGP4 only; rev/day^3
  uint32_t norad = 0;
  int revNumber = 0;
  int elementSetNo = 0;
};

inline Instant epochOf(const Elements& e) {
  return Instant{e.epochDay, static_cast<double>(e.epochTicks) * kEpochTickSeconds};
}
// The epoch as the text carries it: the nearest eight-decimal day.
inline void setEpoch(Elements* e, const Instant& t) {
  int64_t ticks = static_cast<int64_t>(std::floor(t.seconds / kEpochTickSeconds + 0.5));
  e->epochDay = t.day;
  if (ticks >= 100000000) { ticks -= 100000000; e->epochDay += 1; }
  e->epochTicks = ticks;
}
// Minutes from the element set's epoch to an instant: the library's time argument.
inline double minutesSinceEpoch(const Elements& e, const Instant& t) {
  const double seconds = static_cast<double>(t.day - e.epochDay) * kSecondsPerDay + t.seconds -
                         static_cast<double>(e.epochTicks) * kEpochTickSeconds;
  return seconds / 60.0;
}

// ±NNNNN±E: 0.NNNNN × 10^E, the text's form of the drag term and of AGOM. Values under 1e-10 are zero.
inline std::string exponentField(double v) {
  char out[16];
  if (!(std::fabs(v) >= 1.0e-10) || !std::isfinite(v)) {
    std::snprintf(out, sizeof out, " 00000-0");
    return out;
  }
  const char sign = v < 0 ? '-' : ' ';
  const double a = std::fabs(v);
  int e = static_cast<int>(std::floor(std::log10(a))) + 1;
  double mant = a / std::pow(10.0, e);
  if (mant < 0.1) { e -= 1; mant = a / std::pow(10.0, e); }
  else if (mant >= 1.0) { e += 1; mant = a / std::pow(10.0, e); }
  int64_t m = static_cast<int64_t>(std::floor(mant * 1.0e5 + 0.5));
  if (m >= 100000) { m = 10000; e += 1; }
  if (e > 9) { e = 9; m = 99999; }
  if (e < -9) { std::snprintf(out, sizeof out, " 00000-0"); return out; }
  std::snprintf(out, sizeof out, "%c%05lld%c%d", sign, static_cast<long long>(m), e < 0 ? '-' : '+', e < 0 ? -e : e);
  return out;
}
inline double parseExponentField(const std::string& f) {  // the value exponentField writes
  if (f.size() != 8) return 0.0;
  const double sign = f[0] == '-' ? -1.0 : 1.0;
  const double mant = std::strtod(f.substr(1, 5).c_str(), nullptr) * 1.0e-5;
  const int e = (f[6] == '-' ? -1 : 1) * (f[7] - '0');
  return sign * mant * std::pow(10.0, e);
}

inline int tleChecksum(const char* line) {
  int sum = 0;
  for (int i = 0; i < 68; ++i) {
    const char c = line[i];
    if (c >= '0' && c <= '9') sum += c - '0';
    else if (c == '-') sum += 1;
  }
  return sum % 10;
}

struct TleLines {
  char line1[72];
  char line2[72];
};

// The digits the text will carry for each element: rounding an element set to its text is idempotent.
inline double decimals(double v, int places) {
  char b[48];
  std::snprintf(b, sizeof b, "%.*f", places, v);
  return std::strtod(b, nullptr);
}
inline double wrapDegrees(double v, double hi = 360.0) {
  v = std::fmod(v, hi);
  if (v < 0) v += hi;
  return v;
}
inline Elements roundedToText(Elements e) {
  e.meanMotion = decimals(e.meanMotion, 8);
  e.eccentricity = decimals(e.eccentricity, 7);
  e.inclination = decimals(e.inclination, 4);
  e.raan = decimals(wrapDegrees(decimals(e.raan, 4)), 4);
  e.argPerigee = decimals(wrapDegrees(decimals(e.argPerigee, 4)), 4);
  e.meanAnomaly = decimals(wrapDegrees(decimals(e.meanAnomaly, 4)), 4);
  e.drag = parseExponentField(exponentField(e.drag));
  e.agom = parseExponentField(exponentField(e.agom));
  e.meanMotionDot = decimals(e.meanMotionDot, 8);
  e.meanMotionDdot = parseExponentField(exponentField(e.meanMotionDdot));
  return e;
}

// The two lines for a satellite number (the library keys its tree by it; it need not be the NORAD number, which
// the lines do not have to carry for the library to propagate).
inline bool formatTle(const Elements& e, uint32_t satnum, TleLines* out) {
  if (satnum < 1 || satnum > 99999) return false;
  if (!(e.meanMotion > 0) || !(e.eccentricity >= 0) || !(e.eccentricity < 1) || !std::isfinite(e.meanMotion)) return false;
  if (!(e.inclination >= 0) || !(e.inclination <= 180)) return false;
  int64_t y, m, d;
  civilFromDays(e.epochDay - kMjdOfUnixEpoch, &y, &m, &d);
  const int64_t doy = (e.epochDay - kMjdOfUnixEpoch) - daysFromCivil(y, 1, 1) + 1;
  char l1[96];
  const int year2 = static_cast<int>(y % 100);
  char ndot[16];
  const double nd = e.xp ? 0.0 : e.meanMotionDot;
  std::snprintf(ndot, sizeof ndot, "%c.%08lld", nd < 0 ? '-' : ' ',
                static_cast<long long>(std::floor(std::fabs(nd) * 1.0e8 + 0.5)));
  const std::string second = exponentField(e.xp ? e.agom : e.meanMotionDdot);
  const std::string drag = exponentField(e.drag);
  std::snprintf(l1, sizeof l1, "1 %05uU 00001A   %02d%03lld.%08lld %s %s %s %d %4d", satnum, year2,
                static_cast<long long>(doy), static_cast<long long>(e.epochTicks), ndot, second.c_str(), drag.c_str(),
                e.xp ? 4 : 0, e.elementSetNo % 10000);
  // l1 is 68 characters; the checksum is the 69th.
  if (std::strlen(l1) != 68) return false;
  std::snprintf(out->line1, sizeof out->line1, "%s%d", l1, tleChecksum(l1));

  const int64_t ecc = static_cast<int64_t>(std::floor(e.eccentricity * 1.0e7 + 0.5));
  char l2[96];
  std::snprintf(l2, sizeof l2, "2 %05u %8.4f %8.4f %07lld %8.4f %8.4f %11.8f%5d", satnum, e.inclination,
                wrapDegrees(e.raan) >= 359.99995 ? 0.0 : wrapDegrees(e.raan), static_cast<long long>(ecc),
                wrapDegrees(e.argPerigee) >= 359.99995 ? 0.0 : wrapDegrees(e.argPerigee),
                wrapDegrees(e.meanAnomaly) >= 359.99995 ? 0.0 : wrapDegrees(e.meanAnomaly), e.meanMotion, e.revNumber % 100000);
  if (std::strlen(l2) != 68) return false;
  std::snprintf(out->line2, sizeof out->line2, "%s%d", l2, tleChecksum(l2));
  return true;
}

// ---------------------------------------------------------------------------------------------------------------
// The records of a fit.
// ---------------------------------------------------------------------------------------------------------------
struct Sample {
  Instant t;
  double r[3] = {0, 0, 0};  // TEME, km
  double v[3] = {0, 0, 0};  // TEME, km/s; meaningful when hasVelocity
  bool hasVelocity = false;
};

struct Statistics {
  size_t count = 0;
  double rms = 0;     // 3D position, km
  double max = 0;
  double radial = 0;  // RMS of each component of the position error in the model's radial, along-track and
  double along = 0;   // cross-track axes (km)
  double cross = 0;
};

struct DayStatistics {
  int day = 0;  // the day after the end of the fit interval, from 1
  Statistics statistics;
};

struct FitResult {
  bool ok = false;
  const char* code = "";
  std::string message;
  Elements elements;
  Statistics fit;
  Statistics heldOut;
  std::vector<DayStatistics> heldOutDays;
  double firstPassRms = 0;  // before the first iteration, km
  double rmsBeforeLattice = 0;  // at the continuous optimum, before the lattice search, km
  int iterations = 0;
  bool converged = false;
  size_t evaluations = 0;
  std::string trace;  // debugging only (SGP4XP_TRACE)
};

}  // namespace sgp4xp
