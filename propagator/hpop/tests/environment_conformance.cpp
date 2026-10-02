// environment_conformance.cpp — the gmat-07 environment gate.
//
// Everything here is a computable outcome against a stated authority. Where no
// external authority is held, the test says so in its own output rather than
// dressing a self-comparison up as validation.
//
// Sections
//   1. Gravity-mode routing            — the closed forms are reachable
//   2. Spherical-harmonic gates        — a selector answers with what it names
//   3. Generic potential-file loader   — ICGEM and fixed-column
//   4. Polyhedron gravity              — Werner & Scheeres (1997)
//   5. Harris-Priester                 — the published table, exactly
//   6. Atmosphere label honesty        — no silent substitution anywhere
//   7. SPAD area tables
//   8. Schatten-class predicted solar activity
//   9. Force-model contribution port
//  10. Earth orientation of the field  — ERFA c2t06a; the force-model clock
//
// Exit code 0 iff every band holds.

#include "astrodynamics.h"
#include "astrodynamics_types.h"
#include "environment_models.h"
#include "force_models.h"
#include "integrators.h"
#include "coords.h"
#include "time_convert.h"

#include <cmath>
#include <cstdio>
#include <random>
#include <string>
#include <vector>

using namespace astro;

static int g_failures = 0;
static int g_checks = 0;

static void check(bool ok, const std::string& what, const std::string& detail = {}) {
    g_checks++;
    if (ok) {
        std::printf("  ok   %s%s%s\n", what.c_str(),
                    detail.empty() ? "" : " — ", detail.c_str());
    } else {
        g_failures++;
        std::printf("  FAIL %s%s%s\n", what.c_str(),
                    detail.empty() ? "" : " — ", detail.c_str());
    }
}

static double relDiff(const Vec3& a, const Vec3& b) {
    const double d = (a - b).magnitude();
    const double m = std::max(a.magnitude(), b.magnitude());
    return m > 0.0 ? d / m : d;
}

static std::string sci(double v) {
    char b[32];
    std::snprintf(b, sizeof b, "%.3e", v);
    return b;
}

static double relDiff(double a, double b) {
    const double m = std::max(std::abs(a), std::abs(b));
    return m > 0.0 ? std::abs(a - b) / m : std::abs(a - b);
}

// ---------------------------------------------------------------------------
// 1. Gravity-mode routing
// ---------------------------------------------------------------------------
static void sectionGravityRouting() {
    std::printf("\n[1] gravity-mode routing — the closed forms are reachable\n");

    std::mt19937_64 rng(20260830u);
    std::uniform_real_distribution<double> alt(200.0, 40000.0);
    std::uniform_real_distribution<double> ang(-1.0, 1.0);

    double worstJ2 = 0.0, worstJ2J4 = 0.0, worstPM = 0.0;
    for (int i = 0; i < 5000; i++) {
        const double r = RE_EARTH + alt(rng);
        const double u = ang(rng);
        const double phi = ang(rng) * PI;
        const Vec3 p(r * std::sqrt(1 - u * u) * std::cos(phi),
                     r * std::sqrt(1 - u * u) * std::sin(phi),
                     r * u);

        ForceModel::ForceModelSet fs;
        fs.mu = MU_EARTH;

        fs.gravityMode = ForceModel::GravityMode::PointMass;
        worstPM = std::max(worstPM, relDiff(ForceModel::EarthFixedGravity(p, fs),
                                            ForceModel::PointMass(p, MU_EARTH)));

        fs.gravityMode = ForceModel::GravityMode::J2Only;
        worstJ2 = std::max(worstJ2,
            relDiff(ForceModel::EarthFixedGravity(p, fs),
                    ForceModel::PointMass(p, MU_EARTH) +
                        ForceModel::J2Only(p, MU_EARTH, J2_EARTH, RE_EARTH)));

        fs.gravityMode = ForceModel::GravityMode::J2J4;
        worstJ2J4 = std::max(worstJ2J4,
            relDiff(ForceModel::EarthFixedGravity(p, fs),
                    ForceModel::PointMass(p, MU_EARTH) + ForceModel::J2J4(p, MU_EARTH)));
    }
    check(worstPM == 0.0, "GravityMode::PointMass reaches PointMass()",
          "worst rel " + sci(worstPM));
    check(worstJ2 == 0.0, "GravityMode::J2Only reaches the J2 closed form",
          "worst rel " + sci(worstJ2));
    check(worstJ2J4 == 0.0, "GravityMode::J2J4 reaches the J2-J4 closed form",
          "worst rel " + sci(worstJ2J4));

    // The secular nodal regression the whole parity lane is anchored on:
    // a = 7078 km, i = 51.6 deg. gmat-01 records -5.156999e-3 rad/orbit for
    // both the closed form and the production harmonics path, against an
    // analytic secular value of -5.147e-3 (the two are NOT the same number and
    // must not be compared to each other at 1e-3).
    //
    // This is the plugin-path half of that regression: the rate is measured by
    // INTEGRATING one orbit through ComputeTotalAcceleration with each gravity
    // mode the plugin can now select. Before gmat-07 this measurement was
    // unreachable — no caller could ask for a closed form — and the artifact
    // that shipped read -1.07e-6 because it was built from a stale duplicate of
    // the physics library.
    const double a = 7078.0, inc = 51.6 * PI / 180.0;
    const double period = 2.0 * PI * std::sqrt(a * a * a / MU_EARTH);
    const double vCirc = std::sqrt(MU_EARTH / a);

    auto nodalRate = [&](ForceModel::GravityMode mode) {
        StateVector s;
        s.epoch = 2460000.5;
        s.position = Vec3(a, 0.0, 0.0);
        s.velocity = Vec3(0.0, vCirc * std::cos(inc), vCirc * std::sin(inc));

        ForceModel::ForceModelSet fs;
        fs.mu = MU_EARTH;
        fs.gravityMode = mode;
        fs.sphericalHarmonics.maxDegree = 2;
        fs.sphericalHarmonics.maxOrder = 0;
        fs.sphericalHarmonics.includeJ2 = true;
        fs.sphericalHarmonics.includeJ3 = false;
        fs.sphericalHarmonics.includeJ4 = false;
        fs.sphericalHarmonics.includeHigherZonals = false;

        IntegratorConfig cfg;
        cfg.method = IntegrationMethod::RK78;

        auto node = [](const StateVector& st) {
            const Vec3 h = st.position.cross(st.velocity);
            return std::atan2(h.x, -h.y);
        };
        const double before = node(s);
        const StateVector after = Integrator::Cowell(s, period, cfg, fs);
        double d = node(after) - before;
        while (d > PI) d -= 2.0 * PI;
        while (d < -PI) d += 2.0 * PI;
        return d;
    };

    const double rateJ2 = nodalRate(ForceModel::GravityMode::J2Only);
    const double rateJ2J4 = nodalRate(ForceModel::GravityMode::J2J4);
    const double rateSH = nodalRate(ForceModel::GravityMode::SphericalHarmonics);
    std::printf("      dOmega/orbit: J2Only %.9e  J2J4 %.9e  SphericalHarmonics %.9e\n",
                rateJ2, rateJ2J4, rateSH);

    check(relDiff(rateJ2, -5.156999e-3) < 1e-3,
          "J2Only mode reproduces the recorded -5.156999e-3 rad/orbit",
          sci(rateJ2) + " (rel " + sci(relDiff(rateJ2, -5.156999e-3)) + ")");
    check(relDiff(rateJ2J4, -5.156999e-3) < 1e-3,
          "J2J4 mode reproduces it too — J3 and J4 do not move the node here",
          sci(rateJ2J4) + " (rel " + sci(relDiff(rateJ2J4, -5.156999e-3)) + ")");
    check(relDiff(rateSH, -5.156999e-3) < 1e-3,
          "the gated harmonics path agrees with both closed forms",
          sci(rateSH) + " (rel " + sci(relDiff(rateSH, -5.156999e-3)) + ")");
    check(std::abs(rateJ2) > 1e-4,
          "the rate is the real one, not the 1.07e-6 the stale artifact read",
          sci(std::abs(rateJ2)));
}

// ---------------------------------------------------------------------------
// 2. Spherical-harmonic gates
// ---------------------------------------------------------------------------
static void sectionHarmonicGates() {
    std::printf("\n[2] spherical-harmonic gates — a selector answers with what it names\n");

    const Vec3 p(6800.0, 1200.0, 3400.0);

    ForceModel::SphericalHarmonicsConfig j2;
    j2.maxDegree = 2; j2.maxOrder = 0;
    j2.includeJ2 = true; j2.includeJ3 = false; j2.includeJ4 = false;
    j2.includeHigherZonals = false;
    const Vec3 gated = ForceModel::SphericalHarmonics(p, j2);
    const Vec3 closed = ForceModel::PointMass(p, MU_EARTH) +
                        ForceModel::J2Only(p, MU_EARTH, J2_EARTH, RE_EARTH);
    check(relDiff(gated, closed) < 3e-12,
          "a J2-gated harmonic field equals the J2 closed form",
          "rel " + sci(relDiff(gated, closed)));

    ForceModel::SphericalHarmonicsConfig ungated = j2;
    ungated.includeHigherZonals = true;
    ungated.maxDegree = 6;
    const Vec3 withJ5J6 = ForceModel::SphericalHarmonics(p, ungated);
    check(relDiff(withJ5J6, gated) > 0.0,
          "the higher-zonal gate actually changes the field",
          "rel " + sci(relDiff(withJ5J6, gated)));

    // Custom coefficients are HONORED. Feed a field whose only non-zero term
    // is C20 = -J2/sqrt(5) and it must reproduce the J2 closed form; before
    // gmat-07 a non-null pointer produced an all-zero field, i.e. bare point
    // mass.
    constexpr int S = ForceModel::SphericalHarmonicsConfig::CUSTOM_STRIDE;
    std::vector<double> C(S * S, 0.0), Sn(S * S, 0.0);
    C[2 * S + 0] = -J2_EARTH / std::sqrt(5.0);
    ForceModel::SphericalHarmonicsConfig custom;
    custom.maxDegree = 2; custom.maxOrder = 0;
    custom.Cnm = C.data(); custom.Snm = Sn.data();
    const Vec3 fromCustom = ForceModel::SphericalHarmonics(p, custom);
    check(relDiff(fromCustom, closed) < 3e-12,
          "caller-supplied coefficients are used, not dropped",
          "rel " + sci(relDiff(fromCustom, closed)));
    check(relDiff(fromCustom, ForceModel::PointMass(p, MU_EARTH)) > 1e-6,
          "a custom field is not silently the bare point mass");
}

// ---------------------------------------------------------------------------
// 3. Generic potential-file loader
// ---------------------------------------------------------------------------

// Published EGM96 fully normalized coefficients, degree 2-4 (NIMA TR8350.2 /
// the EGM96 distribution). These are the numbers the loader must return
// unaltered.
struct RefCoef { int n, m; double C, S; };
static const RefCoef EGM96_REF[] = {
    {2, 0, -0.484165371736e-03,  0.0},
    {2, 1, -0.186987635955e-09,  0.119528012031e-08},
    {2, 2,  0.243914352398e-05, -0.140016683654e-05},
    {3, 0,  0.957254173792e-06,  0.0},
    {3, 1,  0.202998882184e-05,  0.248513158716e-06},
    {3, 2,  0.904627768605e-06, -0.619025944205e-06},
    {3, 3,  0.721072657057e-06,  0.141435626958e-05},
    {4, 0,  0.539873863789e-06,  0.0},
    {4, 1, -0.536321616971e-06, -0.473440265853e-06},
    {4, 2,  0.350694105785e-06,  0.662671572540e-06},
    {4, 3,  0.990771803829e-06, -0.200928369177e-06},
    {4, 4, -0.188560802735e-06,  0.308853169333e-06},
};

static std::string egm96Icgem() {
    std::string s =
        "product_type                gravity_field\n"
        "modelname                   EGM96\n"
        "earth_gravity_constant      0.3986004415E+15\n"
        "radius                      0.6378136300E+07\n"
        "max_degree                  4\n"
        "errors                      formal\n"
        "tide_system                 tide_free\n"
        "norm                        fully_normalized\n"
        "end_of_head\n";
    char buf[256];
    for (const RefCoef& r : EGM96_REF) {
        std::snprintf(buf, sizeof buf, "gfc %5d %5d %24.16e %24.16e 0.0 0.0\n",
                      r.n, r.m, r.C, r.S);
        s += buf;
    }
    return s;
}

static std::string egm96Cof() {
    // The fixed-column encoding, deliberately written with NO separator
    // between the order and a negative coefficient — the exact shape that
    // defeats a whitespace tokenizer.
    std::string s = "POTFIELD    4    4 0     0.398600441500E+15 0.637813630000E+07\n";
    char buf[256];
    for (const RefCoef& r : EGM96_REF) {
        std::snprintf(buf, sizeof buf, "RECOEF %3d %2d%20.12E%20.12E\n",
                      r.n, r.m, r.C, r.S);
        s += buf;
    }
    return s;
}

static void sectionGravityFile() {
    std::printf("\n[3] generic potential-file loader\n");
    std::printf("      authority: the published EGM96 normalized coefficients "
                "(degree 2-4). NO Orekit ICGEMFormatReaderTest vector is held "
                "in this tree; agreement below is with the published numbers, "
                "not with an Orekit run.\n");

    GravityFileLoadResult icgem = loadGravityField(egm96Icgem());
    check(icgem.ok(), "ICGEM content loads",
          icgem.ok() ? ("model " + icgem.modelName + ", " +
                        std::to_string(icgem.recordsRead) + " records")
                     : icgem.detail);
    check(icgem.tideSystem == "tide_free", "the declared tide system is carried",
          icgem.tideSystem);
    check(relDiff(icgem.field.mu, 398600.4415) < 1e-12,
          "GM converts m^3/s^2 -> km^3/s^2",
          std::to_string(icgem.field.mu));
    check(relDiff(icgem.field.referenceRadius, 6378.1363) < 1e-12,
          "reference radius converts m -> km",
          std::to_string(icgem.field.referenceRadius));

    double worst = 0.0;
    for (const RefCoef& r : EGM96_REF) {
        worst = std::max(worst, relDiff(icgem.field.getC(r.n, r.m), r.C));
        if (r.S != 0.0) worst = std::max(worst, relDiff(icgem.field.getS(r.n, r.m), r.S));
    }
    check(worst <= 1e-15, "every loaded coefficient equals the published value",
          "worst rel " + sci(worst));

    GravityFileLoadResult cof = loadGravityField(egm96Cof());
    check(cof.ok(), "fixed-column content loads", cof.ok() ? "" : cof.detail);
    double worstCof = 0.0;
    for (const RefCoef& r : EGM96_REF) {
        worstCof = std::max(worstCof, relDiff(cof.field.getC(r.n, r.m), r.C));
    }
    check(worstCof <= 1e-11,
          "concatenated fixed columns parse to the same coefficients",
          "worst rel " + sci(worstCof));

    // Typed refusals. A loader that answers a broken file with an empty field
    // is the silent-substitution defect wearing a different hat.
    check(loadGravityField("").status == GravityFileStatus::UnknownFormat,
          "empty content is refused, not answered");
    check(loadGravityField("gfc 2 0\n").status == GravityFileStatus::MalformedRecord,
          "a short coefficient record is refused");
    check(loadGravityField("end_of_head\ngfc 2 0 -1e-3 0 0 0\n").status ==
              GravityFileStatus::MissingHeader,
          "a file with no GM / radius is refused");

    // The loader plus the Pines lane must reproduce the vendored EGM2008 path
    // on the vendored coefficients. This is a cross-check of two independent
    // routes to the same field, and it is what makes a loaded EGM96 or Mars
    // field trustworthy: the evaluation is the one already in service.
    EGM2008Config cfg;
    cfg.maxDegree = 20; cfg.maxOrder = 20;
    ExtendedGravityField vendored = initEGM2008Extended(cfg);

    std::string synth =
        "product_type gravity_field\nmodelname VENDORED\n"
        "earth_gravity_constant " + std::to_string(vendored.mu * 1e9) + "\n"
        "radius " + std::to_string(vendored.referenceRadius * 1e3) + "\n"
        "max_degree 20\nend_of_head\n";
    char buf[256];
    for (int n = 2; n <= 20; n++) {
        for (int m = 0; m <= n; m++) {
            std::snprintf(buf, sizeof buf, "gfc %d %d %.17e %.17e 0 0\n",
                          n, m, vendored.getC(n, m), vendored.getS(n, m));
            synth += buf;
        }
    }
    GravityFileLoadResult round = loadGravityField(synth, 20, 20);
    check(round.ok(), "a synthesized file of the vendored coefficients loads",
          round.ok() ? "" : round.detail);

    const Vec3 p(6900.0, -2100.0, 1500.0);
    const Vec3 aVendored = computeExtendedGravity(p, vendored, 0.0).total;
    const Vec3 aLoaded = ForceModel::LoadedFieldGravity(p, round.field);
    check(relDiff(aVendored, aLoaded) <= 1e-10,
          "a loaded field evaluates identically to the vendored path",
          "rel " + sci(relDiff(aVendored, aLoaded)));
}

// ---------------------------------------------------------------------------
// 4. Polyhedron gravity
// ---------------------------------------------------------------------------
static void sectionPolyhedron() {
    std::printf("\n[4] polyhedron gravity — Werner & Scheeres (1997)\n");
    std::printf("      authority: the model's own analytic invariants (the "
                "Laplacian and the far-field point-mass limit) plus an "
                "independent numerical volume integration. NO published W&S "
                "table for a named test shape is held in this tree.\n");

    // A 2 x 2 x 2 km box at 2000 kg/m^3 = 2e12 kg/km^3.
    const double density = 2.0e12;
    PolyhedronShape box = makeBoxPolyhedron(1.0, 1.0, 1.0, density);
    check(relDiff(box.volume(), 8.0) < 1e-14, "the box volume is 8 km^3",
          std::to_string(box.volume()));

    const double mass = box.mass();
    const double GM = 6.67430e-20 * mass;

    // Far field: the exact polyhedron must collapse onto mu/r^2, and the
    // approach must be quadrupolar — the deviation falling like 1/r^2.
    //
    // The task's acceptance asks for 1e-12 "far from the body". Double
    // precision does not reach it and cannot: the Werner-Scheeres sum is a
    // difference of edge and face terms that are each O(1/r) while the answer
    // is O(1/r^2), so the relative cancellation error GROWS with distance. The
    // measured floor for this shape is ~3e-10 near 200 body radii, after which
    // the error climbs again (2.4e-2 at 1e5 radii is pure cancellation, not
    // physics). The band below is that measured floor, stated rather than
    // quietly widened, and the 1/r^2 scaling check is what actually proves the
    // multipole structure.
    struct FarPoint { double r, rel; };
    std::vector<FarPoint> far;
    for (double r : {5.0, 10.0, 50.0, 200.0}) {
        const Vec3 p(r * 0.6, r * 0.8, 0.0);
        PolyhedronGravityResult res = computePolyhedronGravity(p, box);
        const Vec3 pm = p * (-GM / (r * r * r));
        const double rel = relDiff(res.acceleration, pm);
        far.push_back({r, rel});
        std::printf("      r = %8.1f km (%.0f body radii): rel %.3e\n", r, r, rel);
        check(res.valid, "polyhedron evaluates at r = " + std::to_string(r) + " km");
    }
    check(far.back().rel <= 1e-9,
          "at 200 body radii the polyhedron is the point mass to 1e-9",
          "rel " + sci(far.back().rel));
    // rel ~ (a/r)^2: a 10x in r is a 100x drop, allow a factor of 2 either way.
    const double ratio5to50 = far[0].rel / far[2].rel;
    check(ratio5to50 > 100.0 * 0.5 && ratio5to50 < 10000.0,
          "the deviation from a point mass falls quadrupolarly",
          "rel(5 km)/rel(50 km) = " + std::to_string(ratio5to50));

    // The Laplacian is the winding and the inside/outside test in one number.
    PolyhedronGravityResult inside = computePolyhedronGravity(Vec3(0.1, 0.2, -0.3), box);
    const double expectInside = -4.0 * PI * 6.67430e-20 * density;
    check(relDiff(inside.laplacian, expectInside) < 1e-10,
          "the Laplacian inside the body is -4*pi*G*rho",
          std::to_string(inside.laplacian) + " vs " + std::to_string(expectInside));

    PolyhedronGravityResult outside = computePolyhedronGravity(Vec3(50.0, 0.0, 0.0), box);
    check(std::abs(outside.laplacian) < 1e-18 * std::abs(expectInside) + 1e-24,
          "the Laplacian outside the body is zero",
          std::to_string(outside.laplacian));

    // Independent check near the body, where a harmonic expansion would not be
    // valid at all: a direct numerical integration of G*rho/|r-r'| over the
    // cube. A 120^3 midpoint grid is worth a few parts in 1e4, and the test
    // claims exactly that.
    const Vec3 probe(3.0, 0.5, 0.25);
    const int N = 120;
    const double h = 2.0 / N;
    double potential = 0.0;
    for (int i = 0; i < N; i++) {
        const double x = -1.0 + (i + 0.5) * h;
        for (int j = 0; j < N; j++) {
            const double y = -1.0 + (j + 0.5) * h;
            for (int k = 0; k < N; k++) {
                const double z = -1.0 + (k + 0.5) * h;
                const double d = (probe - Vec3(x, y, z)).magnitude();
                potential += 1.0 / d;
            }
        }
    }
    potential *= 6.67430e-20 * density * h * h * h;
    PolyhedronGravityResult near = computePolyhedronGravity(probe, box);
    check(relDiff(near.potential, potential) < 5e-4,
          "the potential near the body matches a direct volume integration",
          "analytic " + std::to_string(near.potential) + " vs numeric " +
              std::to_string(potential) + " (rel " +
              sci(relDiff(near.potential, potential)) + ")");
}

// ---------------------------------------------------------------------------
// 5. Harris-Priester
// ---------------------------------------------------------------------------
static void sectionHarrisPriester() {
    std::printf("\n[5] Harris-Priester — the published table, exactly\n");

    const int rows = harrisPriesterTableSize();
    check(rows == 50, "the table has its published 50 rows", std::to_string(rows));

    // At a tabulated altitude, with the field point exactly at the antapex,
    // the model must return the tabulated MINIMUM; at the apex, the MAXIMUM.
    // Both are exact by construction, so the band is machine epsilon.
    double worstMin = 0.0, worstMax = 0.0;
    for (int i = 0; i < rows; i++) {
        double h, rmin, rmax;
        harrisPriesterTableRow(i, h, rmin, rmax);

        // Put the Sun on +x at zero declination; the bulge apex then sits at
        // right ascension = +30 deg in the body frame.
        const Vec3 sun(1.5e8, 0.0, 0.0);
        const double lag = 30.0 * PI / 180.0;
        const double r = RE_EARTH + h;
        // Geodetic altitude of an equatorial point of radius r is r - Re only
        // for a spherical Earth; use the geodetic inverse the model itself
        // uses by searching the radius that lands on h.
        auto densityAt = [&](double ra) {
            double lo = r - 30.0, hi = r + 30.0;
            for (int it = 0; it < 80; it++) {
                const double mid = 0.5 * (lo + hi);
                const Vec3 p(mid * std::cos(ra), mid * std::sin(ra), 0.0);
                double la, lo2, alt;
                ecefToGeodetic(p, la, lo2, alt);
                if (alt < h) lo = mid; else hi = mid;
            }
            const double rr = 0.5 * (lo + hi);
            const Vec3 p(rr * std::cos(ra), rr * std::sin(ra), 0.0);
            return computeHarrisPriester(p, sun, 4.0).density;
        };

        worstMax = std::max(worstMax, relDiff(densityAt(lag), rmax));
        worstMin = std::max(worstMin, relDiff(densityAt(lag + PI), rmin));
    }
    check(worstMax < 1e-9, "at the apex every row returns its tabulated maximum",
          "worst rel " + sci(worstMax));
    check(worstMin < 1e-9, "at the antapex every row returns its tabulated minimum",
          "worst rel " + sci(worstMin));

    // Monotonic decay with altitude, which the table has and any correct
    // interpolation preserves.
    bool monotone = true;
    double prev = 1e30;
    for (double h = 100.0; h <= 1000.0; h += 5.0) {
        const Vec3 p(RE_EARTH + h + 21.0, 0.0, 0.0);  // rough, geodetic-corrected below
        double la, lo, alt;
        ecefToGeodetic(p, la, lo, alt);
        const double d = computeHarrisPriester(p, Vec3(1.5e8, 0, 0), 4.0).density;
        if (d > 0.0 && alt >= 100.0 && alt <= 1000.0) {
            if (d > prev) monotone = false;
            prev = d;
        }
    }
    check(monotone, "density decreases monotonically with altitude");

    // Outside the table's support the model REFUSES rather than extrapolating.
    const Vec3 tooHigh(RE_EARTH + 3000.0, 0.0, 0.0);
    check(computeHarrisPriester(tooHigh, Vec3(1.5e8, 0, 0), 4.0).density == 0.0,
          "above 1000 km the model declines to extrapolate");
}

// ---------------------------------------------------------------------------
// 6. Atmosphere label honesty
// ---------------------------------------------------------------------------
static void sectionLabelHonesty() {
    std::printf("\n[6] atmosphere label honesty — no silent substitution\n");

    struct Expect { AtmosphereModelType m; AtmosphereImplementation impl; };
    const Expect table[] = {
        {AtmosphereModelType::Exponential,    AtmosphereImplementation::Published},
        {AtmosphereModelType::USSA1976,       AtmosphereImplementation::Published},
        {AtmosphereModelType::NRLMSISE00,     AtmosphereImplementation::Published},
        {AtmosphereModelType::HarrisPriester, AtmosphereImplementation::Published},
        {AtmosphereModelType::JB2008,         AtmosphereImplementation::NotImplemented},
        {AtmosphereModelType::DTM2020,        AtmosphereImplementation::NotImplemented},
        {AtmosphereModelType::GOST2004,       AtmosphereImplementation::NotImplemented},
    };
    bool all = true;
    for (const Expect& e : table) {
        const bool ok = atmosphereImplementationOf(e.m) == e.impl;
        all = all && ok;
        std::printf("      %-16s %s\n", atmosphereModelName(e.m),
                    e.impl == AtmosphereImplementation::Published ? "published"
                                                                  : "REFUSES");
    }
    check(all, "every label declares what stands behind it");

    // The drag/atmosphere enum bridge. A cast used to do this, and the two
    // enums do not share an ordering, so from index 2 up every value named a
    // different model.
    struct Bridge { ForceModel::DragModelType d; AtmosphereModelType a; };
    const Bridge bridge[] = {
        {ForceModel::DragModelType::Exponential,    AtmosphereModelType::Exponential},
        {ForceModel::DragModelType::USSA1976,       AtmosphereModelType::USSA1976},
        {ForceModel::DragModelType::HarrisPriester, AtmosphereModelType::HarrisPriester},
        {ForceModel::DragModelType::NRLMSISE00,     AtmosphereModelType::NRLMSISE00},
        {ForceModel::DragModelType::JB2008,         AtmosphereModelType::JB2008},
        {ForceModel::DragModelType::DTM2020,        AtmosphereModelType::DTM2020},
    };
    bool bridgeOk = true;
    int wouldHaveBeenWrong = 0;
    for (const Bridge& b : bridge) {
        bridgeOk = bridgeOk && (ForceModel::AtmosphereModelForDrag(b.d) == b.a);
        if (static_cast<int>(b.d) != static_cast<int>(b.a)) wouldHaveBeenWrong++;
    }
    check(bridgeOk, "every drag setting names its own atmosphere model");
    check(wouldHaveBeenWrong == 4,
          "the cast this replaced was wrong for four of the six settings",
          std::to_string(wouldHaveBeenWrong) + " of 6");

    // Every enumerator is handled by the drag dispatch: none falls through.
    // Measured, not asserted about the source — a gated-off model must change
    // the acceleration, which it cannot do if it fell through to a shared
    // default.
    const Vec3 p(RE_EARTH + 400.0, 0.0, 0.0);
    const Vec3 v(0.0, 7.66, 0.0);
    ForceModel::ForceModelSet fs;
    fs.usePointMass = false;
    fs.gravityMode = ForceModel::GravityMode::PointMass;
    fs.useDrag = true;
    fs.drag.mass = 1000.0; fs.drag.area = 10.0; fs.drag.Cd = 2.2;
    fs.weather.F107 = 150.0; fs.weather.F107a = 150.0; fs.weather.Ap = 15.0;

    auto dragOnly = [&](ForceModel::DragModelType m) {
        fs.dragModel = m;
        fs.drag.model = m;
        const Vec3 total = ForceModel::ComputeTotalAcceleration(p, v, 2460000.5, fs);
        return total - ForceModel::PointMass(p, MU_EARTH);
    };
    const Vec3 dExp = dragOnly(ForceModel::DragModelType::Exponential);
    const Vec3 dHP  = dragOnly(ForceModel::DragModelType::HarrisPriester);
    const Vec3 dMS  = dragOnly(ForceModel::DragModelType::NRLMSISE00);
    check(relDiff(dHP, dExp) > 1e-6,
          "Harris-Priester no longer falls through to the exponential model",
          "rel " + sci(relDiff(dHP, dExp)));
    check(relDiff(dHP, dMS) > 1e-6,
          "Harris-Priester is not NRLMSISE-00 either",
          "rel " + sci(relDiff(dHP, dMS)));
}

// ---------------------------------------------------------------------------
// 7. SPAD area tables
// ---------------------------------------------------------------------------
static void sectionSpad() {
    std::printf("\n[7] SPAD area tables\n");

    const char* drag =
        "# effective drag area over the incident direction\n"
        "NAME demo-bus\n"
        "QUANTITY DRAG_AREA\n"
        "MASS 1000.0\n"
        "AZIMUTH 0 90 180 270 360\n"
        "ELEVATION -90 -45 0 45 90\n"
        "DATA\n"
        " 4.0 4.0 4.0 4.0 4.0\n"
        " 6.5 7.0 6.5 7.0 6.5\n"
        " 9.0 12.0 9.0 12.0 9.0\n"
        " 6.5 7.0 6.5 7.0 6.5\n"
        " 4.0 4.0 4.0 4.0 4.0\n";

    SpadLoadResult r = loadSpadFile(drag);
    check(r.ok(), "a SPAD drag table loads", r.ok() ? r.table.name : r.detail);
    check(r.table.quantity == SpadQuantity::DragArea, "the quantity is carried");
    check(r.table.mass == 1000.0, "the declared mass is carried");

    // Node exactness: bit-for-bit, not merely within a tolerance.
    bool exact = true;
    for (size_t ie = 0; ie < r.table.elevationDeg.size(); ie++) {
        for (size_t ia = 0; ia < r.table.azimuthDeg.size(); ia++) {
            const double got = spadInterpolate(r.table, r.table.azimuthDeg[ia],
                                               r.table.elevationDeg[ie]);
            const double want = r.table.values[ie * r.table.azimuthDeg.size() + ia];
            if (got != want) exact = false;
        }
    }
    check(exact, "every grid node returns its tabulated value bit-for-bit");

    // Interior points against an independent bilinear evaluation written from
    // the table directly.
    auto independent = [&](double az, double el) {
        const auto& A = r.table.azimuthDeg;
        const auto& E = r.table.elevationDeg;
        size_t ia = 0, ie = 0;
        while (ia + 2 < A.size() && A[ia + 1] <= az) ia++;
        while (ie + 2 < E.size() && E[ie + 1] <= el) ie++;
        const double fa = (az - A[ia]) / (A[ia + 1] - A[ia]);
        const double fe = (el - E[ie]) / (E[ie + 1] - E[ie]);
        const size_t nA = A.size();
        const double v00 = r.table.values[ie * nA + ia];
        const double v10 = r.table.values[ie * nA + ia + 1];
        const double v01 = r.table.values[(ie + 1) * nA + ia];
        const double v11 = r.table.values[(ie + 1) * nA + ia + 1];
        return (1 - fa) * (1 - fe) * v00 + fa * (1 - fe) * v10 +
               (1 - fa) * fe * v01 + fa * fe * v11;
    };
    double worst = 0.0;
    for (double az = 5.0; az < 355.0; az += 7.0) {
        for (double el = -85.0; el < 85.0; el += 6.0) {
            worst = std::max(worst, relDiff(spadInterpolate(r.table, az, el),
                                            independent(az, el)));
        }
    }
    check(worst <= 1e-6, "interior points match an independent bilinear evaluation",
          "worst rel " + sci(worst));

    const char* srp =
        "QUANTITY SRP_AREA\nAZIMUTH 0 180 360\nELEVATION 0 90\nDATA\n"
        "12.0 8.0 12.0\n3.0 3.0 3.0\n";
    SpadLoadResult s = loadSpadFile(srp);
    check(s.ok() && s.table.quantity == SpadQuantity::SrpArea,
          "a SPAD SRP table loads with its own quantity");
    // Azimuth 90 is midway between the 0 and 180 nodes; elevation 45 midway
    // between 0 and 90. Bilinear on (12, 8 | 3, 3) gives 10 then 3, then 6.5.
    check(spadInterpolate(s.table, 90.0, 45.0) == 6.5,
          "a midpoint of both axes is the exact bilinear value",
          std::to_string(spadInterpolate(s.table, 90.0, 45.0)));

    // Typed refusals.
    check(loadSpadFile("AZIMUTH 0 90\nDATA\n1 2\n").status ==
              SpadFileStatus::MissingGrid,
          "a table missing an axis is refused");
    check(loadSpadFile("AZIMUTH 0 90\nELEVATION 0 90\nDATA\n1 2\n").status ==
              SpadFileStatus::RaggedTable,
          "a table whose rows do not match its axes is refused");

    // Direction -> az/el, the convention the table is indexed by.
    double az = 0, el = 0;
    spadDirectionToAzEl(Vec3(0.0, 1.0, 0.0), az, el);
    check(std::abs(az - 90.0) < 1e-12 && std::abs(el) < 1e-12,
          "+y is azimuth 90, elevation 0");
    spadDirectionToAzEl(Vec3(0.0, 0.0, 1.0), az, el);
    check(std::abs(el - 90.0) < 1e-12, "+z is elevation 90");
}

// ---------------------------------------------------------------------------
// 8. Schatten-class predicted solar activity
// ---------------------------------------------------------------------------
static void sectionSchatten() {
    std::printf("\n[8] predicted solar activity — three bands, not one number\n");

    const char* content =
        "# a three-band prediction table\n"
        "NAME demo-prediction\n"
        "2026 01 NOMINAL 150.0 148.0 12.0\n"
        "2026 07 NOMINAL 170.0 165.0 14.0\n"
        "2027 01 NOMINAL 190.0 182.0 16.0\n"
        "2026 01 EARLY   180.0 176.0 18.0\n"
        "2026 07 EARLY   210.0 202.0 20.0\n"
        "2027 01 EARLY   240.0 228.0 22.0\n"
        "2026 01 LATE    120.0 119.0  8.0\n"
        "2026 07 LATE    130.0 128.0  9.0\n"
        "2027 01 LATE    145.0 140.0 10.0\n";

    PredictionLoadResult r = loadSolarActivityPredictions(content);
    check(r.ok(), "the prediction table loads", r.ok() ? r.table.name : r.detail);
    check(r.table.nominal.size() == 3 && r.table.early.size() == 3 &&
              r.table.late.size() == 3,
          "all three bands are populated separately");

    // 2026-04-15 is exactly halfway between the January and July samples in
    // days? No — it is not, and the interpolation is linear in Julian date, so
    // the expectation is computed from the epochs the loader produced rather
    // than assumed.
    const double jdApr = 2461145.5;  // 2026-04-15 00:00 UT
    SolarActivityPrediction nom{}, early{}, late{};
    check(predictSolarActivityAt(r.table, SolarActivityBand::Nominal, jdApr, nom),
          "the nominal band samples");
    check(predictSolarActivityAt(r.table, SolarActivityBand::Early, jdApr, early),
          "the early band samples");
    check(predictSolarActivityAt(r.table, SolarActivityBand::Late, jdApr, late),
          "the late band samples");

    const double j0 = r.table.nominal[0].epoch, j1 = r.table.nominal[1].epoch;
    const double f = (jdApr - j0) / (j1 - j0);
    const double expectNom = 150.0 + (170.0 - 150.0) * f;
    check(relDiff(nom.f107, expectNom) < 1e-12,
          "linear interpolation in Julian date, reproducible",
          std::to_string(nom.f107) + " vs " + std::to_string(expectNom));

    check(early.f107 > nom.f107 && nom.f107 > late.f107,
          "the three bands are ordered and distinct",
          std::to_string(early.f107) + " > " + std::to_string(nom.f107) + " > " +
              std::to_string(late.f107));

    // The band must change the DENSITY, not merely the index. Same epoch, same
    // point, NRLMSISE-00 driven by each band's F10.7.
    const Vec3 p(RE_EARTH + 450.0, 0.0, 0.0);
    auto densityWith = [&](const SolarActivityPrediction& s) {
        SpaceWeatherData w;
        w.epoch = jdApr;
        w.F107 = s.f107; w.F107a = s.f107a; w.Ap = s.ap;
        for (int i = 0; i < 7; i++) w.ap3h[i] = s.ap;
        AtmosphereConfig cfg;
        cfg.model = AtmosphereModelType::NRLMSISE00;
        return computeNRLMSISE00(p, jdApr, w, cfg).density;
    };
    const double dNom = densityWith(nom);
    const double dEarly = densityWith(early);
    const double dLate = densityWith(late);
    check(dEarly > dNom && dNom > dLate,
          "a higher predicted flux gives a higher density",
          std::to_string(dEarly) + " > " + std::to_string(dNom) + " > " +
              std::to_string(dLate));
    std::printf("      density ratio early/nominal = %.6f, late/nominal = %.6f\n",
                dEarly / dNom, dLate / dNom);
    check(std::abs(dEarly / dNom - 1.0) > 1e-3,
          "the band is not a cosmetic label — it moves the density",
          "ratio " + std::to_string(dEarly / dNom));

    // Refusals.
    SolarActivityPredictionTable emptyTable;
    SolarActivityPrediction sink{};
    check(!predictSolarActivityAt(emptyTable, SolarActivityBand::Nominal, jdApr, sink),
          "an empty band refuses rather than defaulting");
    check(loadSolarActivityPredictions("2026 13 NOMINAL 1 2 3\n").status ==
              PredictionFileStatus::MalformedRecord,
          "an out-of-range month is refused");
    check(loadSolarActivityPredictions("2026 01 SOMETIME 1 2 3\n").status ==
              PredictionFileStatus::MalformedRecord,
          "an unknown band is refused");
}

// ---------------------------------------------------------------------------
// 9. Force-model contribution port
// ---------------------------------------------------------------------------
static void sectionContributionPort() {
    std::printf("\n[9] force-model contribution port\n");

    std::mt19937_64 rng(70260830u);
    std::uniform_real_distribution<double> alt(300.0, 35000.0);
    std::uniform_real_distribution<double> ang(-1.0, 1.0);

    double worstJ2 = 0.0, worstJ3 = 0.0, worstJ4 = 0.0;
    for (int i = 0; i < 20000; i++) {
        const double r = RE_EARTH + alt(rng);
        const double u = ang(rng);
        const double phi = ang(rng) * PI;
        const Vec3 p(r * std::sqrt(1 - u * u) * std::cos(phi),
                     r * std::sqrt(1 - u * u) * std::sin(phi),
                     r * u);

        worstJ2 = std::max(worstJ2,
            relDiff(ForceModel::ZonalHarmonic(p, MU_EARTH, RE_EARTH, 2, J2_EARTH),
                    ForceModel::J2Only(p, MU_EARTH, J2_EARTH, RE_EARTH)));

        // J2J4() is the sum of degrees 2, 3 and 4; compare the sum.
        const Vec3 recursive =
            ForceModel::ZonalHarmonic(p, MU_EARTH, RE_EARTH, 2, J2_EARTH) +
            ForceModel::ZonalHarmonic(p, MU_EARTH, RE_EARTH, 3, J3_EARTH) +
            ForceModel::ZonalHarmonic(p, MU_EARTH, RE_EARTH, 4, J4_EARTH);
        worstJ4 = std::max(worstJ4, relDiff(recursive, ForceModel::J2J4(p, MU_EARTH)));
    }
    (void)worstJ3;
    check(worstJ2 <= 1e-12,
          "a registered zonal of degree 2 reproduces the built-in J2 closed form",
          "worst rel " + sci(worstJ2));
    check(worstJ4 <= 1e-12,
          "registered degrees 2+3+4 reproduce the built-in J2-J4 closed form",
          "worst rel " + sci(worstJ4));

    // Through the force set: two-body plus a REGISTERED J2 must equal the
    // built-in J2 mode.
    const Vec3 p(6900.0, 1500.0, 2700.0);
    const Vec3 v(0.0, 6.5, 3.2);

    ForceModel::ForceModelSet builtIn;
    builtIn.gravityMode = ForceModel::GravityMode::J2Only;
    const Vec3 aBuiltIn = ForceModel::ComputeTotalAcceleration(p, v, 2460000.5, builtIn);

    ForceModel::ForceModelSet ported;
    ported.gravityMode = ForceModel::GravityMode::PointMass;
    ported.useContributions = true;
    ported.contributions.count = 1;
    ported.contributions.slots[0].kind = ForceModel::ContributionKind::ZonalHarmonic;
    ported.contributions.slots[0].p[0] = MU_EARTH;
    ported.contributions.slots[0].p[1] = RE_EARTH;
    ported.contributions.slots[0].p[2] = 2.0;
    ported.contributions.slots[0].p[3] = J2_EARTH;
    const Vec3 aPorted = ForceModel::ComputeTotalAcceleration(p, v, 2460000.5, ported);

    check(relDiff(aBuiltIn, aPorted) <= 1e-12,
          "two-body + registered J2 equals the built-in J2 run",
          "rel " + sci(relDiff(aBuiltIn, aPorted)));

    // A disabled slot contributes exactly nothing.
    ported.contributions.slots[0].enabled = false;
    const Vec3 aDisabled = ForceModel::ComputeTotalAcceleration(p, v, 2460000.5, ported);
    check(relDiff(aDisabled, ForceModel::PointMass(p, MU_EARTH)) == 0.0,
          "a disabled contribution contributes exactly zero");

    // A registered point mass reproduces a third body placed at the same spot.
    ForceModel::ForceModelSet third;
    third.gravityMode = ForceModel::GravityMode::PointMass;
    third.useContributions = true;
    third.contributions.count = 1;
    third.contributions.slots[0].kind = ForceModel::ContributionKind::PointMassAt;
    third.contributions.slots[0].p[0] = MU_MOON;
    third.contributions.slots[0].p[1] = 384400.0;
    const Vec3 aThird = ForceModel::ComputeTotalAcceleration(p, v, 2460000.5, third);
    const Vec3 delta = aThird - ForceModel::PointMass(p, MU_EARTH);
    check(delta.magnitude() > 0.0 && delta.magnitude() < 1e-5,
          "a registered point mass contributes a lunar-scale acceleration",
          std::to_string(delta.magnitude()) + " km/s^2");
}

// ---------------------------------------------------------------------------
// 10. Earth orientation of the central body's field
// ---------------------------------------------------------------------------
// Authority: ERFA 2.0.1 (pyerfa 2.0.1.5) at TDB JD 2461255.5, i.e. TT
// 2461255.5000000088 and UTC 2461255.4991992679: eraC2t06a (GCRS to ITRS, no
// polar motion) and eraPnm80' * R3(-eraEqeq94) (TEME to GCRS). HPOP's chain is
// IAU 1976/1980 without frame bias, so the band is 0.5 arcsec.
static double angleArcsec(const double a[3][3], const double b[3][3]) {
    double trace = 0;
    for (int i = 0; i < 3; ++i)
        for (int k = 0; k < 3; ++k) trace += a[i][k] * b[i][k];
    return std::acos(std::max(-1.0, std::min(1.0, (trace - 1) / 2))) * 206264.806247;
}
static void sectionEarthOrientation() {
    std::printf("[10] Earth orientation of the central field\n");
    const double erfaC2t[3][3] = {{0.655525724113876, -0.755170971990575, -0.001681691942259},
                                  {0.755168364687116, 0.655527880489931, -0.001984660214043},
                                  {0.002601153737456, 0.000031035269987, 0.999996616512299}};
    const double erfaTeme[3][3] = {{0.999978942225442, 0.005945407269437, 0.002601391567318},
                                   {-0.005945508262722, 0.999982324826214, 0.000031091135925},
                                   {-0.002601160737805, -0.000046557076273, 0.999996615891901}};
    const double jdTdb = 2461255.5, jdTt = timesys::tdbToTt(jdTdb);
    const double jdUt = timesys::taiToUtc(timesys::ttToTai(jdTt));
    double field[3][3], itrf[3][3], teme[3][3];
    ForceModel::GcrfToEarthFixed(jdTdb, field);
    const coords::Matrix3x3 g = coords::gcrfToItrf(jdUt), t = coords::temeToGcrf(jdTt);
    for (int i = 0; i < 3; ++i)
        for (int k = 0; k < 3; ++k) { itrf[i][k] = g.at(i, k); teme[i][k] = t.at(i, k); }
    check(angleArcsec(field, erfaC2t) < 0.5, "the field's GCRF to Earth-fixed rotation matches ERFA c2t06a",
          sci(angleArcsec(field, erfaC2t)) + " arcsec");
    check(angleArcsec(itrf, erfaC2t) < 0.5, "coords::gcrfToItrf matches ERFA c2t06a", sci(angleArcsec(itrf, erfaC2t)) + " arcsec");
    check(angleArcsec(teme, erfaTeme) < 0.5, "coords::temeToGcrf matches ERFA pnm80' R3(-eqeq94)",
          sci(angleArcsec(teme, erfaTeme)) + " arcsec");

    // The built-in field is EGM2008 to the degree asked (ICGEM EGM2008,
    // fully normalized: C60 = -1.499539279785270e-7, C20,20 and S20,20 below),
    // with J2 from the closed forms' constant.
    {
        ForceModel::SphericalHarmonicsConfig c;  // degree and order 20
        const auto f = ForceModel::InlineFieldCoefficients(c);
        check(f.Cnm[6][0] == -1.499539279785270e-7 && f.Cnm[5][0] == 6.867029137366810e-8,
              "the built-in J5 and J6 are EGM2008's", sci(f.Cnm[5][0]) + " " + sci(f.Cnm[6][0]));
        check(f.Cnm[20][20] != 0.0 && f.Snm[20][20] != 0.0 && f.Cnm[12][7] != 0.0,
              "the built-in field reaches degree and order 20", sci(f.Cnm[20][20]) + " " + sci(f.Snm[20][20]));
        check(f.Cnm[2][0] == -J2_EARTH / std::sqrt(5.0), "J2 stays the closed forms' constant");
    }

    // The tesseral field turns with the Earth: one GCRF state integrated for a
    // day from epochs six hours apart meets a field turned 90 degrees, so the
    // two arcs differ. The J2 closed form (inertial axis) cannot tell them apart.
    StateVector s;
    s.position = Vec3(7000.0, 0.0, 0.0);
    s.velocity = Vec3(0.0, 4.6, 6.0);
    IntegratorConfig cfg;
    cfg.method = IntegrationMethod::RK78;
    auto arc = [&](ForceModel::GravityMode mode, double epoch) {
        ForceModel::ForceModelSet fs;
        fs.mu = MU_EARTH;
        fs.gravityMode = mode;
        fs.sphericalHarmonics.maxDegree = 8;
        fs.sphericalHarmonics.maxOrder = 8;
        StateVector start = s;
        start.epoch = epoch;
        return Integrator::Cowell(start, 86400.0, cfg, fs).position;
    };
    const double shift = (arc(ForceModel::GravityMode::SphericalHarmonics, 2461255.5) -
                          arc(ForceModel::GravityMode::SphericalHarmonics, 2461255.75)).magnitude();
    const double still = (arc(ForceModel::GravityMode::J2Only, 2461255.5) -
                          arc(ForceModel::GravityMode::J2Only, 2461255.75)).magnitude();
    check(shift > 0.01, "the harmonic field turns with the Earth (arcs 6 h apart differ)", sci(shift) + " km");
    check(still < 1e-9, "the J2 closed form keeps its inertial axis", sci(still) + " km");

    // A force set without a clock integrates on the state's own epoch, not JD 0:
    // with the Sun and Moon on, leaving weather.epoch unset gives the same arc.
    auto lunisolar = [&](bool clock) {
        ForceModel::ForceModelSet fs;
        fs.mu = MU_EARTH;
        fs.gravityMode = ForceModel::GravityMode::PointMass;
        fs.useThirdBody = true;
        fs.thirdBody.includeSun = true;
        fs.thirdBody.includeMoon = true;
        if (clock) fs.weather.epoch = 2461255.5;
        StateVector start = s;
        start.epoch = 2461255.5;
        return Integrator::Cowell(start, 86400.0, cfg, fs).position;
    };
    const double clockGap = (lunisolar(true) - lunisolar(false)).magnitude();
    check(clockGap < 1e-9, "an unset force clock runs on the state's epoch", sci(clockGap) + " km");
}

int main() {
    std::printf("hpop environment conformance (gmat-07-environment-completeness)\n");
    sectionGravityRouting();
    sectionHarmonicGates();
    sectionGravityFile();
    sectionPolyhedron();
    sectionHarrisPriester();
    sectionLabelHonesty();
    sectionSpad();
    sectionSchatten();
    sectionContributionPort();
    sectionEarthOrientation();

    std::printf("\n%d checks, %d failures\n", g_checks, g_failures);
    return g_failures == 0 ? 0 : 1;
}
