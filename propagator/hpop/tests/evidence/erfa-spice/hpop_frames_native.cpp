// HPOP's side of the ERFA/SPICE cross-check: its clock, its GCRF -> ITRF
// rotation and the TEME axes the SGP4 module uses, at the reference cases'
// hourly sample epochs. The code under test is compiled from the same sources
// as the shipped modules (propagator/hpop src/cpp/include/hpop/prw_codec.h and
// prw_environment.h, foundation/frames/src/axis_engine.hpp, the vendored ERFA
// amalgamated as build.mjs does); nothing here computes physics of its own.
//
//   hpop-frames <eop.bin>   (UTC ISO 8601 epochs on stdin, one per line)
//
// <eop.bin> is the size-prefixed $EOP stream HPOP receives as
// PRW.EARTH_ORIENTATION in the reference requests (tests/lib/orekitCases.mjs:
// the fixture's payloadBase64). One JSON object per epoch on stdout:
//
//   utc            the epoch, as given
//   leapSeconds    timesys::getLeapSeconds at the UTC date
//   ttWhole/ttFraction  TT seconds since J2000.0 TT, two parts (prw_codec toTT)
//   tdbMinusTtS    prw_codec tdbMinusTtSeconds at that TT
//   jdTdb          the single-double TDB Julian date the force model receives
//                  (timesys::ttToTdb(tt.jdTt()), as prw_dynamics.cpp samples)
//   jdTtUsed       timesys::tdbToTt(jdTdb): the TT EarthRotation evaluates
//   jdUt1          EarthRotation::ut1(jdTdb)
//   c2t            EarthRotation::matrix(jdTdb), GCRF -> ITRF, row-major
//   gmst           force_models.cpp gmst2006 (the solid and ocean tides' GMST)
//                  at EarthRotation::ut1(jdTdb) and jdTtUsed
//   c2tBuiltIn     ForceModel::GcrfToEarthFixed(jdTdb): the rotation used when a
//                  request carries no Earth orientation (IAU 1976/1980, GAST
//                  at UTC, no polar motion)
//   gcrfToTeme     foundation/frames gcrfToTeme at the epoch, built from the
//                  UTC Julian date as propagator/sgp4 temeToGcrf builds it
//   coordsPrecession, coordsNutation, coordsGcrfToTeme
//                  lib/coords.h precession, nutationMatrix and gcrfToTeme at
//                  jdTtUsed (the IAU 1976/1980 chain behind c2tBuiltIn and the
//                  plugin's coords::transform / getTransformMatrix)
#include "hpop/prw_codec.h"
#include "hpop/prw_environment.h"
// The translation unit itself, for gmst2006 (file-local in force_models.cpp).
#include "force_models.cpp"

#include <cstdio>
#include <fstream>
#include <iostream>
#include <iterator>
#include <string>
#include <vector>

using hpop::dynamics::EarthRotation;

static void put(const char* name, const double m[3][3], bool comma = true) {
    std::printf("\"%s\":[", name);
    for (int i = 0; i < 3; ++i)
        for (int j = 0; j < 3; ++j) std::printf("%.17g%s", m[i][j], (i == 2 && j == 2) ? "" : ",");
    std::printf("]%s", comma ? "," : "");
}

int main(int argc, char** argv) {
    if (argc != 2) { std::fprintf(stderr, "usage: hpop-frames <eop.bin>\n"); return 2; }
    std::ifstream in(argv[1], std::ios::binary);
    std::vector<uint8_t> eop((std::istreambuf_iterator<char>(in)), {});
    EarthRotation earth;
    const std::string added = sdn::frames::eop::addPayload(eop.data(), eop.size(), earth.rows);
    if (!added.empty()) { std::fprintf(stderr, "EOP: %s\n", added.c_str()); return 1; }
    if (!earth.validation().empty()) { std::fprintf(stderr, "EOP: %s\n", earth.validation().c_str()); return 1; }

    std::string line;
    while (std::getline(std::cin, line)) {
        if (line.empty()) continue;
        std::string error;
        double whole = 0, fraction = 0, jdUtc = 0;
        hpop::TTEpoch tt;
        if (!hpop::parseIsoSeconds(line, whole, fraction, jdUtc, error) ||
            !hpop::toTT(whole, fraction, jdUtc, timingStandard::UTC, tt, error)) {
            std::fprintf(stderr, "%s: %s\n", line.c_str(), error.c_str());
            return 1;
        }
        const double jdTdb = timesys::ttToTdb(tt.jdTt());
        const double jdTtUsed = timesys::tdbToTt(jdTdb);
        if (!earth.covers(jdTdb)) { std::fprintf(stderr, "%s: %s\n", line.c_str(), earth.error.c_str()); return 1; }
        double c2t[3][3];
        earth.matrix(jdTdb, c2t);

        // propagator/sgp4 temeToGcrf: UTC JD -> ERFA two parts -> TT ->
        // foundation/frames gcrfToTeme (eraPnm06a, eraEe06a).
        double teme[3][3];
        {
            const double day = std::floor(jdUtc - 0.5) + 0.5, frac = jdUtc - day;
            double tai1, tai2;
            sdn::frames::Epoch ep;
            eraUtctai(day, frac, &tai1, &tai2);
            eraTaitt(tai1, tai2, &ep.tt1, &ep.tt2);
            const auto R = sdn::frames::gcrfToTeme(ep);
            for (int i = 0; i < 3; ++i) for (int j = 0; j < 3; ++j) teme[i][j] = R.m[i][j];
        }

        double builtIn[3][3];
        astro::ForceModel::GcrfToEarthFixed(jdTdb, builtIn);
        const double jdUt1 = earth.ut1(jdTdb);
        std::printf("{\"utc\":\"%s\",\"leapSeconds\":%d,\"ttWhole\":%.17g,\"ttFraction\":%.17g,"
                    "\"tdbMinusTtS\":%.17g,\"jdTdb\":%.17g,\"jdTtUsed\":%.17g,\"jdUt1\":%.17g,\"gmst\":%.17g,",
                    line.c_str(), timesys::getLeapSeconds(jdUtc), tt.whole, tt.fraction,
                    hpop::tdbMinusTtSeconds(tt.jdTt()), jdTdb, jdTtUsed, jdUt1, astro::ForceModel::gmst2006(jdUt1, jdTtUsed));
        put("c2t", c2t);
        put("c2tBuiltIn", builtIn);
        put("gcrfToTeme", teme);
        double cp[3][3], cn[3][3], ct[3][3];
        {
            const auto P = coords::precession(jdTtUsed), N = coords::nutationMatrix(jdTtUsed), T = coords::gcrfToTeme(jdTtUsed);
            for (int i = 0; i < 3; ++i)
                for (int j = 0; j < 3; ++j) { cp[i][j] = P.at(i, j); cn[i][j] = N.at(i, j); ct[i][j] = T.at(i, j); }
        }
        put("coordsPrecession", cp);
        put("coordsNutation", cn);
        put("coordsGcrfToTeme", ct, false);
        std::printf("}\n");
    }
    return 0;
}
