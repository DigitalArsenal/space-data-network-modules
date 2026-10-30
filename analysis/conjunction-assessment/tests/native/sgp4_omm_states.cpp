// The reference states of tests/sgp4OmmInput.e2e.mjs: foundation/sgp4-str3, the stack's one SGP4/SDP4 (Spacetrack
// Report No. 3 with the corrections AIAA 2006-6753 documents), WGS-72, AFSPC mode, on an element set's decimal text as
// published, built natively. No module code is used. The epoch is split exactly from its text (the Julian date of the
// day's 0h, and the second of the day over 86400) and each time from its Julian date (sdnap::split_jd); minutes since
// epoch are the difference of the two splits.
// stdin, one set a line:
//   <EPOCH> <MEAN_MOTION rev/day> <ECCENTRICITY> <INCLINATION deg> <RA_OF_ASC_NODE deg> <ARG_OF_PERICENTER deg>
//   <MEAN_ANOMALY deg> <BSTAR> <count> <Julian date UTC ...>
// stdout per Julian date: <status> <x y z km> <vx vy vz km/s> (TEME, %.17g), then a line "X".
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <vector>

#include "sgp4_str3.h"

static bool split_epoch(const std::string& iso, double& whole, double& frac) {
    int year = 0, month = 0, day = 0, hour = 0, minute = 0;
    if (iso.size() < 19 || std::sscanf(iso.c_str(), "%4d-%2d-%2dT%2d:%2d:", &year, &month, &day, &hour, &minute) != 5)
        return false;
    std::string second = iso.substr(17);
    if (!second.empty() && second.back() == 'Z') second.pop_back();
    const size_t point = second.find('.');
    const int whole_seconds = std::atoi(second.substr(0, point).c_str());
    const double fraction = point == std::string::npos ? 0.0 : std::strtod(("0." + second.substr(point + 1)).c_str(), nullptr);
    const int a = (14 - month) / 12, y = year + 4800 - a, m = month + 12 * a - 3;
    const double day_number = day + (153 * m + 2) / 5 + 365 * y + y / 4 - y / 100 + y / 400 - 32045;
    whole = day_number - 0.5;
    frac = ((hour * 3600 + minute * 60 + whole_seconds) + fraction) / 86400.0;
    return true;
}

int main() {
    char epoch[64], n[48], e[48], i[48], node[48], argp[48], ma[48], bstar[48];
    int count = 0;
    while (std::scanf("%63s %47s %47s %47s %47s %47s %47s %47s %d", epoch, n, e, i, node, argp, ma, bstar, &count) == 9) {
        std::vector<double> jds(count);
        for (double& jd : jds) std::scanf("%lf", &jd);
        sdnap::Elements el{};
        if (!split_epoch(epoch, el.epoch_jd_whole, el.epoch_jd_frac)) return 2;
        const double deg = sdnap::kPi / 180.0;
        el.xno = std::strtod(n, nullptr) * sdnap::kTwoPi / 1440.0;
        el.eo = std::strtod(e, nullptr);
        el.xincl = std::strtod(i, nullptr) * deg;
        el.xnodeo = std::strtod(node, nullptr) * deg;
        el.omegao = std::strtod(argp, nullptr) * deg;
        el.xmo = std::strtod(ma, nullptr) * deg;
        el.bstar = std::strtod(bstar, nullptr);
        sdnap::Sat sat;
        const int init = sdnap::sat_init(el, sdnap::gravity_wgs72(), sat, sdnap::Sgp4Mode::kAfspc);
        for (double jd : jds) {
            double whole = 0, frac = 0, r[3] = {0, 0, 0}, v[3] = {0, 0, 0};
            sdnap::split_jd(jd, whole, frac);
            const double minutes = ((whole - el.epoch_jd_whole) + (frac - el.epoch_jd_frac)) * 1440.0;
            const int status = init != sdnap::kPropOk ? init : sdnap::sat_propagate(sat, nullptr, minutes, r, v);
            std::printf("%d %.17g %.17g %.17g %.17g %.17g %.17g\n", status, r[0], r[1], r[2], v[0], v[1], v[2]);
        }
        std::printf("X\n");
    }
    return 0;
}
