// HPOP's GNSS radiation pressure (lib/gnss_srp.h) against Orekit 13.1.
//
// Authority: tests/fixtures/orekit/orekit-gnss-srp-reference.json, written by
// OrekitGnssSrpReference.java (the model mapping is in its header): Orekit's
// BoxAndSolarArraySpacecraft under its GPSBlockIIF/IIR attitude providers for
// the box-wing of Rodriguez-Solano et al. (2012, doi:10.1016/j.asr.2012.01.016)
// and Orekit's ECOM2 for Arnold et al. (2015, doi:10.1007/s00190-015-0814-4).
// GCRF, SI on Orekit's side, km and km/s here; UTC epochs, integrated on TT
// (HPOP's clock is TDB from the same UTC). Sun from JPL DE440 on both sides
// (de440-2026.bsp here, lnxp1990.440 there).
//
// Three checks per case, each with its tolerance and why:
//   1. The radiation acceleration at each of Orekit's 25 hourly states,
//      relative to its magnitude: 1e-9. Both evaluate the same closed forms
//      on the same geometry; what differs is the Sun (two DE440 readers) and
//      roundoff, below 1e-10 of the force. In penumbra the eclipse case's
//      attitude differs (Orekit begins the midnight turn), so a sample with
//      a visible fraction below 1 is held to 1e-3 of the full-Sun force.
//   2. The trajectory over 24 h, point mass plus the model, largest 3D
//      position difference: 2 mm. Integration error on both sides (HPOP
//      RK78 at 1e-13 with steps to the shadow boundaries, Orekit
//      DormandPrince853 at 1e-14 and 10 s): the point-mass cases of
//      orekit_reference.test.mjs agree to 0.6 mm a day; a 1e-9 relative
//      force error moves GPS by under 1 mm a day.
//      The STM against Orekit's, largest relative difference of a column
//      (position and velocity rows apart): 1e-6. Measured 1e-9 to 5e-9 in
//      sunlight and 4e-8 through the eclipses, where the steps around the
//      penumbra kinks differ (orekit_reference.test.mjs holds the STM to
//      1e-4 and measures GPS at 4e-11). The point mass dominates the STM; the
//      radiation terms' own partials are checked against differences of the
//      force in force_partials_native.cpp.
//   3. ECOM2 only: the state's sensitivity to each of the eleven
//      coefficients against Orekit's parameter Jacobian, largest relative
//      difference of a column (position and velocity rows apart): 1e-6.
//      ECOM2 enters linearly; both integrate the same variational equations.
//
// Input (tests/gnss_srp.test.mjs re-frames the JSON, orchestration only):
//   kernel <path>
//   ecom2 <11 coefficients, m/s^2>
//   case <name> <IIF|IIR> <boxwing|ecom2> <massKg> <samples>
//   s <t s> <x y z m> <vx vy vz m/s> <UTC ISO> <ax ay az m/s^2> <36 STM values> [<66 Jacobian values>]
#include "astrodynamics.h"
#include "ephemeris.h"
#include "force_models.h"
#include "force_partials.h"
#include "gnss_srp.h"
#include "time_convert.h"
#include "variational.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <fstream>
#include <iostream>
#include <iterator>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

using namespace astro;

namespace {
struct Sample { double t, r[3], v[3], a[3]; std::string utc; std::vector<double> stm, jacobian; };
struct Case { std::string name, block, model; double mass; std::vector<Sample> samples; };

// JD UTC of "YYYY-MM-DDThh:mm:ss.sssZ" (Fliegel & Van Flandern day number).
double julianUtc(const std::string& iso) {
    int y, mo, d, h, mi; double s;
    if (std::sscanf(iso.c_str(), "%d-%d-%dT%d:%d:%lf", &y, &mo, &d, &h, &mi, &s) != 6) throw std::runtime_error("bad epoch " + iso);
    const int a = (14 - mo) / 12, yy = y + 4800 - a, mm = mo + 12 * a - 3;
    const long jdn = d + (153 * mm + 2) / 5 + 365L * yy + yy / 4 - yy / 100 + yy / 400 - 32045;
    return jdn - 0.5 + (h + (mi + s / 60.0) / 60.0) / 24.0;
}
double tdbOf(const std::string& iso) { return timesys::ttToTdb(timesys::taiToTt(timesys::utcToTai(julianUtc(iso)))); }

int failures = 0;
void check(const std::string& what, double value, double limit) {
    const bool ok = std::isfinite(value) && value <= limit;
    std::cout << (ok ? "PASS " : "FAIL ") << what << ' ' << value << " (limit " << limit << ")\n";
    if (!ok) ++failures;
}
}  // namespace

int main(int argc, char** argv) {
    try {
        if (argc != 2) throw std::runtime_error("usage: gnss-srp <input>");
        std::ifstream in(argv[1]);
        std::string word, kernelPath;
        gnss_srp::Ecom2 ecom;
        std::vector<Case> cases;
        while (in >> word) {
            if (word == "kernel") in >> kernelPath;
            else if (word == "ecom2") {
                ecom.enabled = true;
                for (int k = 0; k <= int(gnss_srp::Ecom2Term::B3s); ++k) in >> gnss_srp::Ecom2Coefficient(ecom, gnss_srp::Ecom2Term(k));
            } else if (word == "case") {
                Case c; size_t n; in >> c.name >> c.block >> c.model >> c.mass >> n;
                for (size_t i = 0; i < n; ++i) {
                    Sample s; in >> word >> s.t;
                    for (double& x : s.r) in >> x;
                    for (double& x : s.v) in >> x;
                    in >> s.utc;
                    for (double& x : s.a) in >> x;
                    s.stm.resize(36); for (double& x : s.stm) in >> x;
                    if (c.model == "ecom2") { s.jacobian.resize(66); for (double& x : s.jacobian) in >> x; }
                    c.samples.push_back(s);
                }
                cases.push_back(c);
            }
        }
        std::ifstream k(kernelPath, std::ios::binary);
        std::vector<uint8_t> bytes((std::istreambuf_iterator<char>(k)), {});
        if (!Ephemeris::loadEphemerisBuffer(bytes.data(), bytes.size(), Ephemeris::EphemerisSource::JPL_DE440))
            throw std::runtime_error("kernel load failed");

        for (const Case& c : cases) {
            ForceModel::ForceModelSet f;
            f.gravityMode = ForceModel::GravityMode::PointMass;
            f.usePointMass = true;
            f.mu = 3.986004415e5;
            f.useSRP = true;
            f.srp.mass = c.mass;
            std::vector<ForceModel::DynamicParameter> parameters;
            if (c.model == "boxwing") {
                f.srp.model = ForceModel::SRPModelType::GnssBoxWing;
                f.srp.gnssBoxWing = gnss_srp::GpsBoxWing(c.block == "IIF" ? gnss_srp::GpsBlock::IIF : gnss_srp::GpsBlock::IIR);
            } else {
                f.srp.model = ForceModel::SRPModelType::Cannonball;
                f.srp.Cr = 0;  // ECOM2 alone
                f.srp.ecom2 = ecom;
                for (int p = int(ForceModel::DynamicParameter::Ecom2D0); p <= int(ForceModel::DynamicParameter::Ecom2B3s); ++p)
                    parameters.push_back(ForceModel::DynamicParameter(p));
            }
            // 1. Accelerations at Orekit's states.
            double worstLit = 0, worstPenumbra = 0; int shadowed = 0;
            for (const Sample& s : c.samples) {
                const double jd = tdbOf(s.utc);
                const Vec3 r(s.r[0] / 1e3, s.r[1] / 1e3, s.r[2] / 1e3), v(s.v[0] / 1e3, s.v[1] / 1e3, s.v[2] / 1e3);
                const Vec3 sun = getSunPosition(jd).position;
                const Vec3 a = ForceModel::SolarRadiation(r, v, sun, f.srp) * 1e3;  // m/s^2
                const double ref = std::hypot(s.a[0], s.a[1], s.a[2]);
                const double diff = std::hypot(a.x - s.a[0], a.y - s.a[1], a.z - s.a[2]);
                const gnss_srp::V3<double> rr(r.x, r.y, r.z), ss(sun.x, sun.y, sun.z);
                const double lit = gnss_srp::Lit(rr, ss, RE_EARTH);
                if (lit >= 1.0) worstLit = std::max(worstLit, diff / ref);
                else { ++shadowed; worstPenumbra = std::max(worstPenumbra, diff / 1.0e-7); }
            }
            check(c.name + " acceleration, sunlit, relative", worstLit, 1e-9);
            check(c.name + " acceleration, " + std::to_string(shadowed) + " samples in shadow, relative to 1e-7 m/s^2", worstPenumbra, 1e-3);
            // 2. Trajectory; 3. ECOM2 sensitivities.
            const Sample& s0 = c.samples[0];
            StateVector x0(Vec3(s0.r[0] / 1e3, s0.r[1] / 1e3, s0.r[2] / 1e3), Vec3(s0.v[0] / 1e3, s0.v[1] / 1e3, s0.v[2] / 1e3), tdbOf(s0.utc));
            IntegratorConfig config;
            config.method = IntegrationMethod::RK78;
            config.absTolerance = config.relTolerance = 1e-13;
            config.initialStep = 30; config.minStep = 1e-3; config.maxStep = 300; config.maxSteps = 1000000;
            double worstPosition = 0, worstPositionAt = 0, worstColumn = 0, worstStm = 0;
            for (size_t i = 1; i < c.samples.size(); ++i) {
                const Sample& s = c.samples[i];
                // Elapsed TT seconds: Orekit's offsets on its TAI clock (a difference of
                // Julian dates would lose 40 us to the double's resolution).
                const double dt = s.t - s0.t;
                ForceModel::ForceModelSet g = f;
                const auto out = Integrator::PropagateVariational(x0, dt, config, g, ForceModel::DensityGradient::Neglected, parameters);
                if (!out.success) throw std::runtime_error(c.name + ": " + out.errorMessage);
                const double d = std::hypot(out.finalState.position.x * 1e3 - s.r[0], out.finalState.position.y * 1e3 - s.r[1], out.finalState.position.z * 1e3 - s.r[2]);
                if (d > worstPosition) { worstPosition = d; worstPositionAt = s.t; }
                for (int j = 0; j < 6; ++j) for (int half = 0; half < 2; ++half) {
                    double num = 0, den = 0;
                    for (int row = 3 * half; row < 3 * half + 3; ++row) {
                        // Orekit's SI STM in HPOP's km units: rows / columns scale cancel
                        // except position-velocity blocks, which are both length/time-consistent.
                        const double mine = out.stm.m[row][j], ref = s.stm[row * 6 + j];
                        num += (mine - ref) * (mine - ref); den += ref * ref;
                    }
                    worstStm = std::max(worstStm, std::sqrt(num / den));
                }
                const size_t np = parameters.size();
                for (size_t q = 0; q < np; ++q) for (int half = 0; half < 2; ++half) {
                    double num = 0, den = 0;
                    for (int row = 3 * half; row < 3 * half + 3; ++row) {
                        const double mine = out.sensitivity[row * np + q] * 1e3, ref = s.jacobian[row * np + q];
                        num += (mine - ref) * (mine - ref); den += ref * ref;
                    }
                    worstColumn = std::max(worstColumn, std::sqrt(num / den));
                }
            }
            check(c.name + " trajectory, metres (at " + std::to_string(int(worstPositionAt / 3600)) + " h)", worstPosition, 2e-3);
            check(c.name + " STM, relative", worstStm, 1e-6);
            if (!parameters.empty()) check(c.name + " ECOM2 sensitivities, relative", worstColumn, 1e-6);
        }
        std::cout << (failures ? "FAIL" : "PASS") << " gnss srp cases=" << cases.size() << " failures=" << failures << '\n';
        return failures ? 1 : 0;
    } catch (const std::exception& e) {
        std::cerr << e.what() << '\n';
        return 2;
    }
}
