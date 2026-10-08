// Evaluates the ported density models at the fixture arguments read from
// stdin, one model per line ("jb2008 <15 numbers>" or "jacchia70 <13
// numbers>"), and prints one density per line.
#include "jb2008.h"
#include "jacchia_roberts.h"
#include <cstdio>
#include <cstring>
int main() {
    char model[32];
    while (std::scanf("%31s", model) == 1) {
        if (!std::strcmp(model, "jb2008")) {
            double v[15];
            for (double& x : v) if (std::scanf("%lf", &x) != 1) return 2;
            const astro::jb2008::Inputs in{v[6], v[7], v[8], v[9], v[10], v[11], v[12], v[13], v[14]};
            std::printf("%.17g\n", astro::jb2008::density(v[0], v[1], v[2], v[3], v[4], v[5], in));
        } else if (!std::strcmp(model, "jacchia70")) {
            double v[13];
            for (double& x : v) if (std::scanf("%lf", &x) != 1) return 2;
            const double point[3] = {v[2], v[3], v[4]}, sun[3] = {v[5], v[6], v[7]};
            const astro::jacchia_roberts::Inputs in{v[10], v[11], v[12]};
            std::printf("%.17g\n", astro::jacchia_roberts::density(v[0], v[1], point, sun, v[8], v[9], in));
        } else return 3;
    }
    return 0;
}
