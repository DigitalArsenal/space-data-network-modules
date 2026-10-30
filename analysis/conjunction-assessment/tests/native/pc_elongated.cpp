// Full-state Pc on needle covariances (T sigma hundreds of km, R/N a few km):
// the 3D-Nc work bound, its named refusals, byte identity with the previous
// integral, and Foster's disk integral against a long-double reference.
// Synthetic encounters only: invented circular LEO orbits, RTN covariances
// passed as the bridge passes a source covariance (make_pc_encounter).
//   pc_elongated identity <fixtures>  one line per encounter, compared across builds
//   pc_elongated bound                the two encounters that ran for minutes
//   pc_elongated accuracy             Foster, aspect ratio 1 to 1e4
//   pc_elongated tracks               the KERNEL encounter as sampled tracks (JSON)
// Units: km, km/s, km^2, s; epoch JD 2461343.5 UTC.
#include "conjunction/conjunction_engine.h"
#include "conjunction/encounter_geometry.h"
#include "conjunction/pc_fallbacks.h"
#include "conjunction/pc_method.h"
#include <array>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <fstream>
#include <iostream>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

using namespace conjunction;
namespace {
void require(bool ok, const std::string& label) { if (!ok) throw std::runtime_error(label); }
constexpr double MU = 398600.4418, PI = 3.14159265358979323846;

// Portable uniform stream (splitmix64), so every platform builds the same cases.
struct Stream {
    std::uint64_t state;
    double next() {
        std::uint64_t z = (state += 0x9e3779b97f4a7c15ULL);
        z = (z ^ (z >> 30)) * 0xbf58476d1ce4e5b9ULL; z = (z ^ (z >> 27)) * 0x94d049bb133111ebULL; z ^= z >> 31;
        return static_cast<double>(z >> 11) * 0x1.0p-53;
    }
    double in(double a, double b) { return a + (b - a) * next(); }
};

struct Case {
    std::string name;
    StateVector primary{}, secondary{};
    std::array<double, 21> c1{}, c2{};
    double radius = 0.02;
    PcEncounter encounter() const { return make_pc_encounter(primary, secondary, c1, c2, radius); }
};

double dot3(const double a[3], const double b[3]) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
const double ORBIT_RADIUS = 6928.137, ORBIT_SPEED = std::sqrt(MU / ORBIT_RADIUS), MEAN_MOTION = ORBIT_SPEED / ORBIT_RADIUS;

// A circular primary at 550 km, inclination 53 deg, R = x; a circular
// secondary crossing it at the angle that gives `speed`, offset `miss` in the
// encounter plane at angle `psi` from radial. Both pass the TCA at t = 0.
void geometry(Case& c, double speed, double miss, double psi) {
    const double r = ORBIT_RADIUS, v = ORBIT_SPEED, inc = 53 * PI / 180;
    const double R[3] = {1, 0, 0}, T[3] = {0, std::cos(inc), std::sin(inc)}, N[3] = {0, -std::sin(inc), std::cos(inc)};
    const double theta = 2 * std::asin(std::min(1.0, speed / (2 * v)));
    double h[3];
    { const double a = std::cos(theta) - 1, b = std::sin(theta), l = std::hypot(a, b);
      for (int i = 0; i < 3; ++i) h[i] = (-b * T[i] + a * N[i]) / l; }
    c.primary = {};
    c.primary.epoch_jd = c.secondary.epoch_jd = 2461343.5;
    c.primary.x = r; c.primary.vx = v * T[0]; c.primary.vy = v * T[1]; c.primary.vz = v * T[2];
    double r2[3];
    for (int i = 0; i < 3; ++i) r2[i] = r * R[i] + miss * (std::cos(psi) * R[i] + std::sin(psi) * h[i]);
    const double rn = std::sqrt(dot3(r2, r2)), v2 = std::sqrt(MU / rn);
    double dir[3], up[3] = {r2[0] / rn, r2[1] / rn, r2[2] / rn};
    for (int i = 0; i < 3; ++i) dir[i] = std::cos(theta) * T[i] + std::sin(theta) * N[i];
    const double d = dot3(dir, up);
    for (int i = 0; i < 3; ++i) dir[i] -= d * up[i];
    const double l = std::sqrt(dot3(dir, dir));
    c.secondary.x = r2[0]; c.secondary.y = r2[1]; c.secondary.z = r2[2];
    c.secondary.vx = v2 * dir[0] / l; c.secondary.vy = v2 * dir[1] / l; c.secondary.vz = v2 * dir[2] / l;
}

using M6 = std::array<std::array<double, 6>, 6>;
void mode(M6& m, const std::array<double, 6>& g) { for (int i = 0; i < 6; ++i) for (int j = 0; j < 6; ++j) m[i][j] += g[i] * g[j]; }
std::array<double, 21> packed(const M6& m) {
    std::array<double, 21> out{}; unsigned k = 0;
    for (int i = 0; i < 6; ++i) for (int j = 0; j <= i; ++j) out[k++] = m[i][j];
    return out;
}

// RTN covariances. Model 0, a timing mode: along-track sigma sT carried with
// the radial-velocity term -n*sT a rotation-only RTN covariance holds for it.
// Model 1, uncorrelated diagonal. Model 2, the timing mode plus a semi-major-
// axis mode (drift share `drift`) and three small correlated modes (`mix`,
// position in units of sR, velocity in units of n*sR). The secondary is near-
// isotropic (s2) and, when sT2 > 0, carries its own timing mode.
struct Draws { double drift = 0; std::array<double, 18> mix{}; };
Draws draws(Stream& u) {
    Draws d; d.drift = u.in(0, 50);
    for (double& x : d.mix) x = u.in(-0.5, 0.5);
    return d;
}
void covariances(Case& c, int model, double sT, double sR, double sN, double s2, double sT2, const Draws& d) {
    const double n = MEAN_MOTION;
    M6 a{}, b{};
    if (model == 1) {
        a[0][0] = sR * sR; a[1][1] = sT * sT; a[2][2] = sN * sN;
        a[3][3] = (n * sT) * (n * sT) * 1e-2 + (n * sR) * (n * sR); a[4][4] = (2 * n * sR) * (2 * n * sR); a[5][5] = (n * sN) * (n * sN);
    } else {
        mode(a, {0, sT, 0, -n * sT, 0, 0});
        a[0][0] += sR * sR; a[2][2] += sN * sN;
        a[3][3] += (n * sR) * (n * sR); a[4][4] += (2 * n * sR) * (2 * n * sR); a[5][5] += (n * sN) * (n * sN);
        if (model == 2) {
            mode(a, {sR, -1.5 * sR * d.drift, 0, 0, -0.5 * n * sR, 0});
            for (int k = 0; k < 3; ++k) {
                std::array<double, 6> g{};
                for (int i = 0; i < 6; ++i) g[i] = (i < 3 ? d.mix[6 * k + i] : d.mix[6 * k + i] * n) * sR;
                mode(a, g);
            }
        }
    }
    if (sT2 > 0) mode(b, {0, sT2, 0, -n * sT2, 0, 0});
    for (int i = 0; i < 6; ++i) b[i][i] += i < 3 ? s2 * s2 : (n * s2) * (n * s2);
    c.c1 = packed(a); c.c2 = packed(b);
}

// Encounters whose previous 3D-Nc returned within seconds: the identity set.
std::vector<Case> identity_cases() {
    std::vector<Case> out;
    Stream u{0x0c0ffee5eedULL};
    const double aspects[] = {1, 10, 100, 1000, 10000};
    for (int k = 0; k < 100; ++k) {
        Case c; const double aspect = aspects[k % 5];
        const double sR = u.in(0.05, 3), sN = sR * u.in(0.5, 2), sT = aspect * sR;
        const double speed = u.in(1, 15), miss = u.in(0.05, 20), psi = u.in(0, 2 * PI);
        const int model = static_cast<int>(u.in(0, 3));
        const double s2 = u.in(0.05, 2), sT2 = u.next() < 0.3 ? u.in(10, 950) : 0;
        c.radius = u.in(0.005, 0.05);
        const Draws d = draws(u);
        geometry(c, speed, miss, psi);
        covariances(c, model, sT, sR, sN, s2, sT2, d);
        std::ostringstream name; name << "synthetic-" << k << "-aspect-" << aspect << "-model-" << model;
        c.name = name.str();
        out.push_back(c);
    }
    return out;
}

std::string hex(double x) { char b[40]; std::snprintf(b, sizeof b, "%a", x); return b; }
std::string flatten(std::string s) { for (char& ch : s) if (ch == '\n') ch = ' '; return s; }
std::string event_line(const std::string& name, const ConjunctionEvent2& e) {
    std::ostringstream o;
    o << "EVENT " << name << " method=" << e.pc.method << " converged=" << e.pc.converged
      << " has_covariance=" << e.has_covariance << " pc=" << hex(e.pc.probability)
      << " lower=" << hex(e.pc.lower_probability) << " upper=" << hex(e.pc.upper_probability)
      << " samples=" << e.pc.sample_count << " hits=" << e.pc.collision_count
      << " initial=" << e.pc.initial_overlap_count << " entries=" << e.pc.entry_collision_count
      << " remediated=" << e.pc.covariance_remediated << " usage_violation=" << e.pc.usage_violation
      << " failure=" << flatten(e.pc.failure_reason) << " | " << flatten(e.pc.usage_reason);
    return o.str();
}
std::string nc3_line(const std::string& name, const PcFallbackResult& x) {
    std::ostringstream o;
    o << "NC3 " << name << " converged=" << x.pc.converged << " requires_mc=" << x.requires_monte_carlo
      << " nc=" << hex(x.expected_collisions) << " pc=" << hex(x.pc.probability)
      << " iterations=" << x.pc.iterations << " repaired=" << x.covariance_repaired << " | " << flatten(x.limitation);
    return o.str();
}

std::vector<std::vector<std::string>> rows(const std::string& file) {
    std::ifstream in(file); require(bool(in), "missing public fixture " + file);
    std::string line; std::getline(in, line); std::vector<std::vector<std::string>> out;
    while (std::getline(in, line)) {
        std::stringstream s(line); std::vector<std::string> row; std::string x;
        while (std::getline(s, x, ',')) row.push_back(x);
        out.push_back(row);
    }
    return out;
}
PcEncounter fixture_encounter(const std::vector<std::string>& row) {
    PcEncounter e; size_t k = 1; e.has_velocity_covariance = true;
    for (double& x : e.primary) x = std::stod(row[k++]);
    for (double& x : e.secondary) x = std::stod(row[k++]);
    for (double& x : e.covariance_primary) x = std::stod(row[k++]);
    for (double& x : e.covariance_secondary) x = std::stod(row[k++]);
    e.combined_radius = std::stod(row[k]);
    return e;
}

int identity(const std::string& fixtures) {
    for (const auto& c : identity_cases()) {
        const auto e = c.encounter();
        std::cout << nc3_line(c.name, pc_3d_nc_hall(e)) << "\n";
        ConjunctionEngine engine; engine.set_pc_method("FOSTER");
        std::cout << event_line(c.name, engine.compute_pc(e)) << std::endl;
    }
    // The public CARA encounters, as tests/native/nc_cascade.cpp runs them.
    for (const auto& row : rows(fixtures + "/cara_usage.csv")) {
        const auto e = fixture_encounter(row);
        ConjunctionEngine engine; PcFallbackOptions options; options.samples = 32768; options.seed = 173;
        engine.set_pc_fallback(ConjunctionEngine::Fallback::Automatic, options);
        std::cout << nc3_line("cara-usage-" + row[0], pc_3d_nc_hall(e)) << "\n";
        std::cout << event_line("cara-usage-" + row[0], engine.compute_pc(e)) << std::endl;
    }
    for (const auto& row : rows(fixtures + "/cara_hall.csv")) {
        const auto e = fixture_encounter(row); PcFallbackOptions options;
        options.time_start = std::stod(row[88]); options.time_end = std::stod(row[89]); options.angular_order = 16;
        std::cout << nc3_line("cara-hall-" + row[0], pc_3d_nc_hall(e, options)) << std::endl;
    }
    std::cout << "IDENTITY DONE" << std::endl;
    return 0;
}

// The two synthetic encounters whose previous 3D-Nc ran for minutes.
// KERNEL: the Hall peak-overlap solve fails at epochs inside the window (old:
// 3D-Nc 288 s native, 702,996 epoch evaluations, then discarded). BUDGET: no
// solve fails, the flux is not smooth enough for the time rule (old: 51 s,
// 1.41e9 sphere-point evaluations, 115,129 epochs, then discarded).
Case kernel_case() {
    Case c; c.name = "needle-kernel"; c.radius = 0.046302168300228368;
    geometry(c, 9.692347057471391, 1.2640123674698371, 4.7991200411774244);
    Draws d; d.drift = 48.454591719668535;
    d.mix = {0.070256587396410719, -0.26435390931727787, -0.17608987117775771, 0.29913343521677238, 0.18828757513145242, -0.10398990313229446,
             -0.46869972997454296, 0.42219885685282893, 0.36763690106550329, 0.029771141683916369, -0.27997811243984372, -0.41976300767219177,
             0.47733021642507917, -0.13850970779776328, -0.26395423924874217, 0.18393880481238559, -0.37510165897868025, -0.426702965765763};
    covariances(c, 2, 660.64232388469748, 4.9490337574520034, 1.1184063466117167, 0.1711490803389254, 0, d);
    return c;
}
Case budget_case() {
    Case c; c.name = "needle-budget"; c.radius = 0.030361648444734043;
    geometry(c, 13.560020755472191, 0.15523995717473074, 4.5718734871731534);
    covariances(c, 1, 307.08631064461872, 2.2496601425466856, 2.9813271092734652, 1.4023042078579928, 0, Draws{});
    return c;
}

int bound() {
    struct Expect { Case c; const char* stop; };
    for (const auto& [c, stop] : {Expect{kernel_case(), "NC3_KERNEL_UNAVAILABLE_REQUIRES_MC"}, Expect{budget_case(), "NC3_WORK_BUDGET_REQUIRES_MC"}}) {
        const auto e = c.encounter();
        auto t0 = std::chrono::steady_clock::now();
        const auto three = pc_3d_nc_hall(e);
        const double nc3_s = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
        std::cout << nc3_line(c.name, three) << "\n";
        require(!three.pc.converged && three.requires_monte_carlo, c.name + ": a stopped 3D-Nc is not a probability");
        require(three.limitation.find(stop) != std::string::npos, c.name + ": 3D-Nc must stop by name, " + stop);
        // At most 2^16 distinct epochs per call; iterations count each once per rule pass.
        require(three.pc.iterations <= 6 * 65536, c.name + ": 3D-Nc epoch work above its budget");
        t0 = std::chrono::steady_clock::now();
        ConjunctionEngine engine; engine.set_pc_method("FOSTER");
        const auto event = engine.compute_pc(e);
        const double cascade_s = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
        std::cout << event_line(c.name, event) << "\n";
        require(event.pc.method == "SDMC-TWO-BODY" && event.pc.converged && event.has_covariance, c.name + ": Monte Carlo must answer");
        require(event.pc.sample_count == 65536 && event.pc.upper_probability > event.pc.lower_probability, c.name + ": sampled interval missing");
        require(event.pc.usage_reason.find("3D-NC-HALL rejected") != std::string::npos &&
                event.pc.usage_reason.find(stop) != std::string::npos, c.name + ": cascade trace must carry the named 3D-Nc refusal");
        std::printf("BOUND %s stop=%s nc3_epochs=%d nc3_wall_s=%.3f cascade_wall_s=%.3f\n", c.name.c_str(), stop, three.pc.iterations, nc3_s, cascade_s);
    }
    std::cout << "BOUND DONE" << std::endl;
    return 0;
}

// Foster's disk integral against an independent reference, in binary64 with
// compensated arithmetic (long double is binary64 on some hosts): the plane's
// principal axes from its 2x2 covariance with the determinant formed without
// cancellation (Kahan's FMA difference of products), then polar coordinates
// about the disk center, composite Gauss-Legendre in radius (panels of 16
// nodes, Jacobian r dr) and the periodic trapezoid rule in angle, with
// Neumaier summation. Checked against itself at half the nodes in both.
double difference_of_products(double a, double b, double c, double d) {
    const double w = c * d, e = std::fma(-c, d, w), f = std::fma(a, b, -w);
    return f + e;
}
struct Sum {
    double sum = 0, carry = 0;
    void add(double x) {
        const double t = sum + x;
        carry += std::abs(sum) >= std::abs(x) ? (sum - t) + x : (x - t) + sum;
        sum = t;
    }
    double value() const { return sum + carry; }
};
struct Axes { double minor_miss, major_miss, minor_sigma, major_sigma; };
Axes principal(const BPlaneGeometry& bp) {
    const double xx = bp.sigma_xx, zz = bp.sigma_zz, xz = bp.sigma_xz;
    const double high = 0.5 * (xx + zz) + std::hypot(0.5 * (xx - zz), xz);
    const double low = difference_of_products(xx, zz, xz, xz) / high;
    double ex, ez;  // minor-axis unit vector, from the better-conditioned row
    if (std::abs(low - xx) > std::abs(low - zz)) { ex = xz; ez = low - xx; } else { ex = low - zz; ez = xz; }
    const double norm = std::hypot(ex, ez);
    if (norm > 0) { ex /= norm; ez /= norm; } else { ex = 1; ez = 0; }  // isotropic: any axes
    return {bp.xi * ex + bp.zeta * ez, -bp.xi * ez + bp.zeta * ex, std::sqrt(low), std::sqrt(high)};
}
double reference_disk(const Axes& p, double radius, int panels, int angles) {
    static const double x16[8] = {0.0950125098376374401853193354249581, 0.281603550779258913230460501460496, 0.458016777657227386342419442983578,
        0.617876244402643748446671764048791, 0.755404408355003033895101194847442, 0.865631202387831743880467897712393,
        0.944575023073232576077988415534608, 0.989400934991649932596154173450333};
    static const double w16[8] = {0.189450610455068496285396723208283, 0.182603415044923588866763667969220, 0.169156519395002538189312079030359,
        0.149595988816576732081501730547479, 0.124628971255533872052476282192016, 0.0951585116824927848099251076022463,
        0.0622535239386478928628438369943776, 0.0271524594117540948517805724560181};
    Sum total;
    for (int k = 0; k < panels; ++k) {
        const double a = radius * k / panels, b = radius * (k + 1) / panels, mid = 0.5 * (a + b), half = 0.5 * (b - a);
        for (int i = 0; i < 16; ++i) {
            const double r = mid + (i < 8 ? -1 : 1) * half * x16[i % 8], w = w16[i % 8] * half;
            Sum ring;
            for (int j = 0; j < angles; ++j) {
                const double t = 2 * PI * (j + 0.5) / angles;
                const double x = (p.minor_miss + r * std::cos(t)) / p.minor_sigma, y = (p.major_miss + r * std::sin(t)) / p.major_sigma;
                ring.add(std::exp(-0.5 * (x * x + y * y)));
            }
            total.add(w * r * ring.value() * (2 * PI / angles));
        }
    }
    return total.value() / (2 * PI * p.minor_sigma * p.major_sigma);
}

int accuracy() {
    // Disk radius 20 m; minor sigma 0.1, 1 and 10 disk radii; major sigma the
    // minor times the aspect ratio A; the miss (0,0), (1,0), (0,1), (1,1) and
    // (3,0) sigma along (minor, major); the plane rotated 0, 30 and 90 deg.
    // Stated tolerance 1e-10 + 1e-15 A^2 relative: a rotated plane's minor
    // variance comes from its determinant, which binary64 forms with a
    // relative error near A^2 times the unit roundoff.
    const double radius = 0.02;
    double worst = 0; int cases = 0; long worst_points = 0; double worst_us = 0;
    for (double aspect : {1.0, 10.0, 100.0, 1000.0, 10000.0}) {
        const double tolerance = 1e-10 + 1e-15 * aspect * aspect;
        double max_error = 0, max_us = 0; long max_points = 0; int count = 0;
        for (double minor_scale : {0.1, 1.0, 10.0}) for (double rotation : {0.0, 30.0, 90.0})
            for (auto [kx, ky] : std::array<std::pair<double, double>, 5>{{{0, 0}, {1, 0}, {0, 1}, {1, 1}, {3, 0}}}) {
                const double sx = minor_scale * radius, sy = sx * aspect, mx = kx * sx, my = ky * sy;
                const double angle = rotation * PI / 180, c = std::cos(angle), s = std::sin(angle);
                BPlaneGeometry bp; bp.combined_radius = radius;  // principal (minor x, major y) rotated into the plane
                bp.xi = c * mx - s * my; bp.zeta = s * mx + c * my;
                bp.sigma_xx = c * c * sx * sx + s * s * sy * sy;
                bp.sigma_zz = s * s * sx * sx + c * c * sy * sy;
                bp.sigma_xz = c * s * (sx * sx - sy * sy);
                const auto t0 = std::chrono::steady_clock::now();
                const auto foster = Foster2D().compute(bp);
                const double us = std::chrono::duration<double, std::micro>(std::chrono::steady_clock::now() - t0).count();
                const Axes axes = principal(bp);
                const double ref = reference_disk(axes, radius, 32, 4096), coarse = reference_disk(axes, radius, 16, 2048);
                require(std::abs(coarse / ref - 1) < 1e-12, "reference not converged");
                const double error = std::abs(foster.probability / ref - 1);
                char label[160];
                std::snprintf(label, sizeof label, "Foster against the reference: A=%g minor=%g rotation=%g miss=(%g,%g) error %.3e", aspect, minor_scale, rotation, kx, ky, error);
                require(foster.converged && error <= tolerance, label);
                max_error = std::max(max_error, error); max_us = std::max(max_us, us);
                max_points = std::max<long>(max_points, foster.iterations); ++count;
            }
        std::printf("ACCURACY foster A=%g cases=%d max_relative_error=%.3e tolerance=%.1e max_quadrature_points=%ld max_wall_us=%.1f\n",
                    aspect, count, max_error, tolerance, max_points, max_us);
        worst = std::max(worst, max_error); worst_points = std::max(worst_points, max_points);
        worst_us = std::max(worst_us, max_us); cases += count;
    }
    std::printf("ACCURACY DONE cases=%d max_relative_error=%.3e max_quadrature_points=%ld max_wall_us=%.1f\n", cases, worst, worst_points, worst_us);
    return 0;
}
// The needle-kernel encounter as sampled tracks for the module: each object
// on its circular orbit every 30 s from -120 s to +120 s about the TCA, with
// its RTN covariance (lower triangle, OEM order) at every sample.
int tracks() {
    const Case c = kernel_case();
    auto at = [](const StateVector& s, double t, double out[6]) {
        const double r[3] = {s.x, s.y, s.z}, v[3] = {s.vx, s.vy, s.vz};
        const double rn = std::sqrt(dot3(r, r)), vn = std::sqrt(dot3(v, v)), n = vn / rn;
        for (int i = 0; i < 3; ++i) {
            out[i] = std::cos(n * t) * r[i] + std::sin(n * t) * (rn / vn) * v[i];
            out[i + 3] = vn * (-std::sin(n * t) * r[i] / rn + std::cos(n * t) * v[i] / vn);
        }
    };
    auto list = [](const double* x, int n) { std::ostringstream o; o.precision(17); for (int i = 0; i < n; ++i) o << (i ? "," : "") << x[i]; return o.str(); };
    std::ostringstream o; o.precision(17);
    o << "{\"epochJd\":" << c.primary.epoch_jd << ",\"radiusKm\":" << c.radius
      << ",\"covariance\":{\"primary\":[" << list(c.c1.data(), 21) << "],\"secondary\":[" << list(c.c2.data(), 21) << "]},\"samples\":[";
    for (int t = -120; t <= 120; t += 30) {
        double a[6], b[6]; at(c.primary, t, a); at(c.secondary, t, b);
        o << (t > -120 ? "," : "") << "{\"t\":" << t << ",\"primary\":[" << list(a, 6) << "],\"secondary\":[" << list(b, 6) << "]}";
    }
    o << "]}";
    std::cout << o.str() << std::endl;
    return 0;
}
}  // namespace

int main(int argc, char** argv) {
    try {
        std::cout.precision(17);
        const std::string mode = argc > 1 ? argv[1] : "";
        if (mode == "identity" && argc == 3) return identity(argv[2]);
        if (mode == "bound") return bound();
        if (mode == "accuracy") return accuracy();
        if (mode == "tracks") return tracks();
        throw std::runtime_error("usage: pc_elongated identity <fixtures> | bound | accuracy | tracks");
    } catch (const std::exception& e) {
        std::cerr << "FAIL: " << e.what() << std::endl;
        return 1;
    }
}
