// The base built natively for its tests: TEME states of element sets in improved mode, WGS-72. stdin, one set a line:
//   <days from 1949 Dec 31 0h UT> <n rad/min> <e> <i rad> <raan rad> <argp rad> <M rad> <bstar> <count> <minutes...>
// stdout per time: <minutes> <status> <x y z km> <vx vy vz km/s>, then "X".
#include <cstdio>
#include <vector>
#include "sgp4_str3.h"

int main() {
    double el[8];
    int count;
    while (std::scanf("%lf %lf %lf %lf %lf %lf %lf %lf %d", &el[0], &el[1], &el[2], &el[3], &el[4], &el[5], &el[6], &el[7], &count) == 9) {
        std::vector<double> minutes(count);
        for (double& t : minutes) std::scanf("%lf", &t);
        sdnap::Elements e{};
        e.epoch_jd_whole = el[0] + sdnap::kJd1950;  // the epoch as one Julian date, as the reference takes it
        e.xno = el[1]; e.eo = el[2]; e.xincl = el[3]; e.xnodeo = el[4]; e.omegao = el[5]; e.xmo = el[6]; e.bstar = el[7];
        sdnap::Sat sat;
        const int init = sdnap::sat_init(e, sdnap::gravity_wgs72(), sat, sdnap::Sgp4Mode::kImproved);
        for (double t : minutes) {
            double r[3] = {0, 0, 0}, v[3] = {0, 0, 0};
            const int status = init != sdnap::kPropOk ? init : sdnap::sat_propagate(sat, nullptr, t, r, v);
            std::printf("%.17g %d %.17g %.17g %.17g %.17g %.17g %.17g\n", t, status, r[0], r[1], r[2], v[0], v[1], v[2]);
        }
        std::printf("X\n");
    }
    return 0;
}
