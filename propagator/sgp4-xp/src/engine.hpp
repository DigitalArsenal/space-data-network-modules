// propagator/sgp4-xp: what a program that is not this module calls to fit SGP4-XP element sets to an ephemeris.
//
// The fit engine (the Space Force library through ussf.hpp, the axes of frames.hpp, the fitter of fit.hpp and the
// windows of window.hpp) is one translation unit. This module compiles it together with its own methods; the signed OD
// node of flows/supplemental-omm compiles it alone, as an object, and links it to node code that holds SDS records of
// another pin than this module's. Nothing declared here is an SDS type, so the two pins never meet: states go in as
// plain numbers and element sets and statistics come out as plain numbers (types.hpp).
#pragma once

#include <string>
#include <vector>

#include "types.hpp"

namespace sgp4xp {

// The axes a source writes its states in. TEME is the library's; GCRF (ICRF, J2000A) is the inertial frame of the IAU
// 2006/2000A chain; EME2000 (J2000) is the mean equator and equinox of J2000, which differs from GCRF by the frame
// bias; ITRF is the Earth-fixed frame (ECEF, WGS84, ITRF realizations are one here).
enum class Frame : uint8_t { Teme, Gcrf, Eme2000, Itrf };

// The time scale of a source's stamps. The fit counts UTC, in 86400-second days (the convention of the text's epoch).
enum class TimeScale : uint8_t { Utc, Gps, Tai, Tt };

// A state as the source gives it, its instant already in UTC: position in km and, when the source has one, velocity in km/s.
struct Observed {
  Instant t;
  double r[3] = {0, 0, 0};
  double v[3] = {0, 0, 0};
  bool hasVelocity = false;
};

// How an ephemeris is cut into element sets: each window is fitted on `fitSeconds` (two thirds of the ephemeris when it
// is shorter than a day and a half) and scored on up to `holdSeconds` after them, and the next window starts where the
// last fit ended. A window with less than `minHoldSeconds` of states left to score it is not released.
struct WindowPolicy {
  double fitSeconds = 86400.0;
  double holdSeconds = 86400.0;
  double minHoldSeconds = 10800.0;
  size_t maxWindows = 64;
  size_t maxFitStates = 0;  // states the optimisation sees in a window (the statistics use all); 0 is the fitter's default
};

// One fitted element set: the fit and the interval it was fitted on and scored on.
struct IntervalFit {
  FitResult result;
  Instant fitStart, fitStop, heldStop;
  bool haveHeld = false;
};

struct SourceFit {
  std::vector<IntervalFit> windows;
  std::vector<std::string> refusals;  // one line for each window that could not be fitted: "window N: code: message"
};

// The stamp `iso` (ISO 8601, or year-day-of-year) on `scale`, as UTC. false when it is not a time, or a leap second
// table does not cover it.
bool utcOf(const std::string& iso, TimeScale scale, Instant* out);

// Fits the ephemeris `states` (strictly increasing in time, in `frame`) window by window. norad is carried into the
// element sets. false, with `code` and `why`, when the ephemeris as a whole cannot be fitted (axes, too few states, a
// leap second inside); a window that fails alone is recorded in `out->refusals` and the others are still returned.
bool fitSource(const std::vector<Observed>& states, Frame frame, uint32_t norad, const WindowPolicy& policy, SourceFit* out,
               std::string* code, std::string* why);

}  // namespace sgp4xp
