// The SGP4/SDP4 base foundation/sgp4-str3, built natively without -ffast-math: TEME states of element sets, the
// reference the module's states are held to (run-str3.mjs). stdin, one set a line:
//   <epoch_jd> <n rev/day> <e> <i deg> <raan deg> <argp deg> <M deg> <bstar> <count> <minutes...>
// stdout, one line a time: <minutes> <status> <x y z km> <vx vy vz km/s> (%.17g), then "X".
#include <cmath>
#include <cstdio>
#include <vector>
#include "sgp4_str3.h"

int main() {
    const double rad = M_PI / 180.0;
    double jd, n, e, i, raan, argp, m, bstar;
    int count;
    while (std::scanf("%lf %lf %lf %lf %lf %lf %lf %lf %d", &jd, &n, &e, &i, &raan, &argp, &m, &bstar, &count) == 9) {
        std::vector<double> minutes(count);
        for (double& t : minutes) std::scanf("%lf", &t);
        sdnap::Elements el{};
        el.epoch_jd_whole = jd;  // one Julian date, as the module passes it
        el.xno = n * 2.0 * M_PI / 1440.0;
        el.eo = e;
        el.xincl = i * rad;
        el.xnodeo = raan * rad;
        el.omegao = argp * rad;
        el.xmo = m * rad;
        el.bstar = bstar;
        sdnap::Sat sat;
        const int init = sdnap::sat_init(el, sdnap::gravity_wgs72(), sat, sdnap::Sgp4Mode::kImproved);
        for (double t : minutes) {
            double r[3] = {0, 0, 0}, v[3] = {0, 0, 0};
            const int status = init != sdnap::kPropOk ? init : sdnap::sat_propagate(sat, nullptr, t, r, v);
            std::printf("%.17g %d %.17g %.17g %.17g %.17g %.17g %.17g\n", t, status, r[0], r[1], r[2], v[0], v[1], v[2]);
        }
        std::printf("X\n");
    }
    return 0;
}
