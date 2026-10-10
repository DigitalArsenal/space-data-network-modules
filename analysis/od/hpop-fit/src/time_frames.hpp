// Epochs and frames of the operator-ephemeris fit, one IAU 2006/2000A chain
// (the vendored ERFA that foundation/frames and propagator/hpop compile).
//
// Epochs are two-part UTC Julian dates (ERFA's convention): a single double
// Julian date resolves 40 microseconds, 0.3 m along a LEO track, which the
// 1 cm closure gate cannot afford.
//
// Frames:
//   EME2000 -> GCRF   the IAU 2006 frame bias (eraBp06 rb, transposed).
//   GCRF    -> TEME   Rz(ee06a) * pnm06a at TT: the true equator and mean
//                     equinox SGP4 propagates in, as CelesTrak scores SupGP.
//   ITRF    -> GCRF   the IERS 2010 CIO chain with the caller's $EOP rows
//                     (foundation/frames eop_series: one interpolation rule).
#pragma once

#include <array>
#include <cstdint>
#include <string>
#include <vector>

namespace odhpop {

struct UtcEpoch {
  double jd1 = 0.0;  // the Julian date of the day's 00:00 UTC (ends in .5)
  double jd2 = 0.0;  // the day fraction, [0, 1)
};

using Mat3 = std::array<std::array<double, 3>, 3>;

// Parses "YYYY-MM-DDTHH:MM:SS[.fff...]" (optionally "Z") or
// "YYYY-DDDTHH:MM:SS[.fff]" (day of year), UTC. false on anything else.
bool parse_iso_utc(const std::string& text, UtcEpoch* out);
// An ISO token on the scale `scale` ("UTC", "TAI" or "GPS"; empty = UTC),
// plus `offset_s` SI seconds, as UTC. false on an unknown scale or token.
bool parse_epoch(const std::string& token, const std::string& scale, double offset_s, UtcEpoch* out);
// SpaceX MEME "YYYYDDDHHMMSS.sss", UTC.
bool parse_meme_utc(const std::string& text, UtcEpoch* out);
// ISO 8601 UTC with `decimals` fractional digits (leap seconds as :60).
std::string format_iso_utc(const UtcEpoch& t, int decimals = 9);
// Calendar from a UTC epoch; false outside ERFA's range.
UtcEpoch utc_from_calendar(int year, int month, int day, int hour, int minute, double second);

// TT two-part Julian date of a UTC epoch.
void utc_to_tt(const UtcEpoch& t, double* tt1, double* tt2);
// b - a in SI seconds (TT), exact across leap seconds.
double seconds_between(const UtcEpoch& a, const UtcEpoch& b);
// a + seconds (SI), as UTC.
UtcEpoch add_seconds(const UtcEpoch& a, double seconds);
// Julian date (single double, UTC) for code that takes one.
inline double jd_single(const UtcEpoch& t) { return t.jd1 + t.jd2; }

Mat3 eme2000_to_gcrf();
Mat3 gcrf_to_teme(const UtcEpoch& t);
Mat3 transpose(const Mat3& m);
std::array<double, 3> rotate(const Mat3& m, const double v[3]);

// Earth orientation from a PRW EARTH_ORIENTATION record (the same bytes HPOP
// reads). Rotates ITRF position/velocity to GCRF; velocity includes the Earth
// rotation term.
class EarthOrientation {
 public:
  // Empty string: success.
  std::string load(const uint8_t* prw, std::size_t size);
  bool loaded() const;
  // false outside the rows.
  bool itrf_to_gcrf(const UtcEpoch& t, const double r_itrf[3], const double v_itrf[3],
                    double r_gcrf[3], double v_gcrf[3], std::string* error) const;
  ~EarthOrientation();
  EarthOrientation();
  EarthOrientation(const EarthOrientation&) = delete;
  EarthOrientation& operator=(const EarthOrientation&) = delete;

 private:
  struct Impl;
  Impl* impl_;
};

}  // namespace odhpop
