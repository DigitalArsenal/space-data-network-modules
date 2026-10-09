// Evaluates the ported density models at the fixture arguments read from
// stdin, one request per line, and prints one line per request:
//   "jb2008 <15 numbers>"          -> the JB2008 density
//   "jacchia-roberts <13 numbers>" -> the Jacchia-Roberts density
//   "integrate <Tinf> <height>"    -> Jacchia-Roberts' static density at
//       that exospheric temperature (no hydrogen, no corrections), then the
//       same model integrated numerically from 90 km with Roberts'
//       exponential temperature profile above 125 km, then with Jacchia's
//       arctangent profile (SAO SR 313 eq. 13, SR 332): the independent check
//       of the closed forms and of Roberts' fit. g/cm^3.
#include "jb2008.h"
#include "jacchia_roberts.h"
#include <cmath>
#include <cstdio>
#include <cstring>

namespace {
using namespace astro::jacchia_roberts::detail;
constexpr double RADIUS = 6356.766;  // km: the radius in Jacchia's and Roberts' gravity
double gravity(double z) { return G_ZERO * std::pow(RADIUS / (RADIUS + z), 2); }
double meanMass(double z) { double m = M_CON[6]; for (int i = 5; i >= 0; --i) m = m * z + M_CON[i]; return m; }
struct Profile {
    double tinf, tx, l;
    bool arctangent;
    double operator()(double z) const {
        if (z <= 125) {
            double s = CON_C[4];
            for (int i = 3; i >= 0; --i) s = CON_C[i] + s * z;
            return tx + (tx - TZERO) * s / 1.500625e6;
        }
        if (arctangent) {  // T = Tx + A atan(Gx/A (z - zx)(1 + 4.5e-6 (z - zx)^2.5)), A = 2/pi (Tinf - Tx), Gx = 1.9 (Tx - T0)/35
            const double a = 2 / PI * (tinf - tx), gx = 1.9 * (tx - TZERO) / 35.0, d = z - 125;
            return tx + a * std::atan(gx / a * d * (1 + 4.5e-6 * std::pow(d, 2.5)));
        }
        return tinf - (tinf - tx) * std::exp(-(tx - TZERO) / (tinf - tx) * (z - 125) / 35.0 * l / (RADIUS + z));
    }
};
template <class F>
double simpson(F f, double a, double b, double h) {
    int n = int(std::ceil((b - a) / h));
    n += n % 2;
    h = (b - a) / n;
    double s = f(a) + f(b);
    for (int i = 1; i < n; ++i) s += f(a + i * h) * (i % 2 ? 4 : 2);
    return s * h / 3;
}
// Mixing from 90 to 100 km with Jacchia's mean molecular mass, then each
// species in diffusive equilibrium (helium with thermal diffusion -0.38).
double integrated(const Profile& t, double z) {
    const double t100 = t(100.0);
    const double mixing = simpson([&](double s) { return meanMass(s) * gravity(s) / (GAS_CON * t(s)); }, 90.0, 100.0, 0.005);
    const double rho100 = RHO_ZERO * (TZERO / t100) * (meanMass(100.0) / MZERO) * std::exp(-mixing);
    double mean = 0;
    for (int i = 0; i < 5; ++i) mean += MOL_MASS[i] * NUM_DENS[i];
    const double scale = simpson([&](double s) { return gravity(s) / (GAS_CON * t(s)); }, 100.0, z, 0.01);
    double rho = 0;
    for (int i = 0; i < 5; ++i)
        rho += rho100 * MOL_MASS[i] * NUM_DENS[i] / mean * std::pow(t100 / t(z), i == 2 ? 0.62 : 1.0) * std::exp(-MOL_MASS[i] * scale);
    return rho;
}
}  // namespace

int main() {
    char model[32];
    while (std::scanf("%31s", model) == 1) {
        if (!std::strcmp(model, "jb2008")) {
            double v[15];
            for (double& x : v) if (std::scanf("%lf", &x) != 1) return 2;
            const astro::jb2008::Inputs in{v[6], v[7], v[8], v[9], v[10], v[11], v[12], v[13], v[14]};
            std::printf("%.17g\n", astro::jb2008::density(v[0], v[1], v[2], v[3], v[4], v[5], in));
        } else if (!std::strcmp(model, "jacchia-roberts")) {
            double v[13];
            for (double& x : v) if (std::scanf("%lf", &x) != 1) return 2;
            const double point[3] = {v[2], v[3], v[4]}, sun[3] = {v[5], v[6], v[7]};
            const astro::jacchia_roberts::Inputs in{v[10], v[11], v[12]};
            std::printf("%.17g\n", astro::jacchia_roberts::density(v[0], v[1], point, sun, v[8], v[9], in));
        } else if (!std::strcmp(model, "integrate")) {
            double tinf = 0, z = 0;
            if (std::scanf("%lf %lf", &tinf, &z) != 2 || z < 125 || z > 500) return 2;
            State s;
            s.cbPolarRadius = RADIUS;
            s.cbPolarSquared = RADIUS * RADIUS;
            s.t_infinity = tinf;
            s.tx = 371.6678 + 0.0518806 * tinf - 294.3505 * std::exp(-0.00216222 * tinf);
            s.sum = CON_L[4];
            for (int i = 3; i >= 0; --i) s.sum = CON_L[i] + s.sum * tinf;
            const Profile roberts{tinf, s.tx, s.sum, false}, jacchia{tinf, s.tx, s.sum, true};
            std::printf("%.17g %.17g %.17g\n", rho_high(s, z, roberts(z), roberts(500.0), 0.0, 0.0),
                        integrated(roberts, z), integrated(jacchia, z));
        } else return 3;
    }
    return 0;
}
