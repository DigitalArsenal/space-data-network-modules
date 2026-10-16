// Native oracle harness for run-vallado.mjs, compiled against the module's own
// src/cpp/src/SGP4.cpp (the propagator the wasm carries). Two paths:
//
//   V <opsmode>            Vallado's verification path: twoline2rv(typerun 'v',
//   <line 1>               WGS-72) on the two TLE lines, then sgp4 at each
//   <line 2>               minutes-since-epoch value that follows, as Vallado's
//   T <tsince> ...         testcpp does.
//
//   M <satnum> <iso> <n rev/day> <e> <i deg> <raan deg> <argp deg> <M deg>
//     <bstar> <ndot> <nddot>
//   T <tsince> ...         The module's path, line for line from
//                          sgp4_plugin.cpp: parseEpochIso8601ToJulianDate
//                          (jday_SGP4 to one Julian-date double),
//                          initSatrecFromOMM (invjday_SGP4, jday_SGP4,
//                          sgp4init WGS-72 'i'), propagateEntityTEME
//                          (tsince = (JD - (jdsatepoch + jdsatepochF)) * 1440).
//                          The request JD is epoch_jd + tsince / 1440 in one
//                          double, as a host forms it; the line reports the
//                          JD and the tsince the module then uses.
//
// Output: one line per sample, "S <tsince> <requestJd> <tsinceUsed> <error>
// <r0> <r1> <r2> <v0> <v1> <v2>" in km and km/s, %.17g; "I <error>" when the
// set does not initialise (or fails at its epoch, which the module refuses).
#include "SGP4.h"

#include <cmath>
#include <cstdio>
#include <cstring>
#include <iostream>
#include <sstream>
#include <string>

static constexpr double PI = 3.14159265358979323846;
static constexpr double TWOPI = 2.0 * PI;
static constexpr double DEG_TO_RAD = PI / 180.0;

static void emit(double tsince, double requestJd, double tsinceUsed, elsetrec& satrec) {
  double r[3] = {NAN, NAN, NAN}, v[3] = {NAN, NAN, NAN};
  SGP4Funcs::sgp4(satrec, tsinceUsed, r, v);
  std::printf("S %.17g %.17g %.17g %d %.17g %.17g %.17g %.17g %.17g %.17g\n", tsince, requestJd, tsinceUsed,
              satrec.error, r[0], r[1], r[2], v[0], v[1], v[2]);
}

int main() {
  std::string line;
  elsetrec satrec;
  bool modulePath = false;
  bool ready = false;
  double epochJd = 0.0;  // the module's jdsatepoch + jdsatepochF
  while (std::getline(std::cin, line)) {
    if (line.empty()) continue;
    if (line[0] == 'V') {
      char opsmode = line.size() > 2 ? line[2] : 'i';
      std::string l1, l2;
      std::getline(std::cin, l1);
      std::getline(std::cin, l2);
      char s1[130] = {0}, s2[130] = {0};
      std::strncpy(s1, l1.c_str(), 129);
      std::strncpy(s2, l2.c_str(), 129);
      double startmfe, stopmfe, deltamin;
      std::memset(&satrec, 0, sizeof(satrec));
      SGP4Funcs::twoline2rv(s1, s2, 'v', 'e', opsmode, wgs72, startmfe, stopmfe, deltamin, satrec);
      modulePath = false;
      epochJd = satrec.jdsatepoch + satrec.jdsatepochF;
      ready = satrec.error == 0;
      if (!ready) std::printf("I %d\n", satrec.error);
      else std::printf("E %.17g %.17g %c\n", satrec.jdsatepoch, satrec.jdsatepochF, satrec.method);
    } else if (line[0] == 'M') {
      std::istringstream in(line.substr(2));
      unsigned satnum;
      std::string iso;
      double n, e, inc, raan, argp, ma, bstar, ndot, nddot;
      in >> satnum >> iso >> n >> e >> inc >> raan >> argp >> ma >> bstar >> ndot >> nddot;
      // parseEpochIso8601ToJulianDate
      int year = 0, mon = 0, day = 0, hr = 0, minute = 0;
      double sec = 0.0;
      std::sscanf(iso.c_str(), "%d-%d-%dT%d:%d:%lf", &year, &mon, &day, &hr, &minute, &sec);
      double jd0, jdFrac0;
      SGP4Funcs::jday_SGP4(year, mon, day, hr, minute, sec, jd0, jdFrac0);
      const double ommEpochJd = jd0 + jdFrac0;
      // initSatrecFromOMM
      SGP4Funcs::invjday_SGP4(ommEpochJd, 0.0, year, mon, day, hr, minute, sec);
      double jd, jdFrac;
      SGP4Funcs::jday_SGP4(year, mon, day, hr, minute, sec, jd, jdFrac);
      const double epoch = jd + jdFrac - 2433281.5;
      char satn[6];
      std::snprintf(satn, sizeof(satn), "%05u", satnum);
      std::memset(&satrec, 0, sizeof(satrec));
      const bool ok = SGP4Funcs::sgp4init(wgs72, 'i', satn, epoch, bstar, ndot * TWOPI / (1440.0 * 1440.0),
                                          nddot * TWOPI / (1440.0 * 1440.0 * 1440.0), e, argp * DEG_TO_RAD,
                                          inc * DEG_TO_RAD, ma * DEG_TO_RAD, n * TWOPI / 1440.0, raan * DEG_TO_RAD,
                                          satrec);
      satrec.jdsatepoch = jd;
      satrec.jdsatepochF = jdFrac;
      modulePath = true;
      epochJd = jd + jdFrac;
      ready = ok && satrec.error == 0;
      if (ready) {
        double r[3], v[3];
        ready = SGP4Funcs::sgp4(satrec, 0.0, r, v) && satrec.error == 0;
      }
      if (!ready) std::printf("I %d\n", satrec.error);
      else std::printf("E %.17g %.17g %.17g %c\n", ommEpochJd, jd, jdFrac, satrec.method);
    } else if (line[0] == 'T') {
      std::istringstream in(line.substr(2));
      double tsince;
      while (in >> tsince) {
        if (!ready) continue;
        if (modulePath) {
          const double requestJd = epochJd + tsince / 1440.0;
          emit(tsince, requestJd, (requestJd - epochJd) * 1440.0, satrec);
        } else {
          emit(tsince, 0.0, tsince, satrec);
        }
      }
      std::printf("D\n");
      std::fflush(stdout);
    }
  }
  return 0;
}
