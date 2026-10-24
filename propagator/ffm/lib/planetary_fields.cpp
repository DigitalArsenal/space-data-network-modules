#include "planetary_fields.h"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstring>

#include "erfa.h"
#include "mars_atmosphere_data.h"

namespace astro {
namespace planetary {
namespace {

// The embedded tables (lib/data/planetary, scripts/generate-planetary-data.mjs). #embed is the compiler's own
// inclusion of the file's bytes; nothing is parsed at build time and no source text is generated.
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wc23-extensions"
const unsigned char kGrgm660prim[] = {
#embed "data/planetary/grgm660prim.bin"
};
const unsigned char kMro120f[] = {
#embed "data/planetary/mro120f.bin"
};
const unsigned char kMoonPa[] = {
#embed "data/planetary/moon_pa_de440.bin"
};
#pragma clang diagnostic pop

uint32_t u32(const unsigned char* p) { uint32_t v; std::memcpy(&v, p, 4); return v; }
double f64(const unsigned char* p) { double v; std::memcpy(&v, p, 8); return v; }
float f32(const unsigned char* p) { float v; std::memcpy(&v, p, 4); return v; }

struct Table {
    const unsigned char* bytes;
    size_t size;
};
bool fieldTable(int naifId, Table& t) {
    if (naifId == MOON) { t = {kGrgm660prim, sizeof kGrgm660prim}; return true; }
    if (naifId == MARS) { t = {kMro120f, sizeof kMro120f}; return true; }
    return false;
}

// DE440 libration records: header "FFMP", version, degree, records, first start, length, reserved.
struct Libration {
    uint32_t degree, records;
    double start, length;
    const unsigned char* data;
};
Libration libration() {
    Libration l;
    l.degree = u32(kMoonPa + 8); l.records = u32(kMoonPa + 12);
    l.start = f64(kMoonPa + 16); l.length = f64(kMoonPa + 24);
    l.data = kMoonPa + 40;
    return l;
}

// Chebyshev series sum_k c_k T_k(x), Clenshaw.
double chebyshev(const unsigned char* coefficients, uint32_t count, double x) {
    double b1 = 0, b2 = 0;
    for (int k = int(count) - 1; k >= 1; --k) {
        const double b0 = 2 * x * b1 - b2 + f64(coefficients + 8 * size_t(k));
        b2 = b1; b1 = b0;
    }
    return x * b1 - b2 + f64(coefficients);
}

// Passive rotations: the coordinates of a fixed vector in axes turned by theta about x, z.
void rx(double theta, double m[3][3]) {
    const double c = std::cos(theta), s = std::sin(theta);
    const double r[3][3] = {{1, 0, 0}, {0, c, s}, {0, -s, c}};
    std::memcpy(m, r, sizeof r);
}
void rz(double theta, double m[3][3]) {
    const double c = std::cos(theta), s = std::sin(theta);
    const double r[3][3] = {{c, s, 0}, {-s, c, 0}, {0, 0, 1}};
    std::memcpy(m, r, sizeof r);
}
void multiply(const double a[3][3], const double b[3][3], double out[3][3]) {
    double t[3][3];
    for (int i = 0; i < 3; ++i) for (int j = 0; j < 3; ++j) t[i][j] = a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j];
    std::memcpy(out, t, sizeof t);
}

constexpr double kDegToRad = 3.14159265358979323846264338327950288 / 180.0;

bool moonRotation(const timesys::Instant& tt, double m[3][3]) {
    const Libration l = libration();
    const double et = tt.tdb().secondsSinceJ2000();
    const double index = std::floor((et - l.start) / l.length);
    if (!(index >= 0 && index < double(l.records))) return false;
    const size_t k = size_t(index);
    const double mid = l.start + (double(k) + 0.5) * l.length;
    const double x = (et - mid) / (0.5 * l.length);
    const size_t stride = 8 * size_t(l.degree + 1);
    const unsigned char* record = l.data + k * 3 * stride;
    const double phi = chebyshev(record, l.degree + 1, x);
    const double delta = chebyshev(record + stride, l.degree + 1, x);
    const double w = chebyshev(record + 2 * stride, l.degree + 1, x);
    // MOON_PA = R3(w) R1(delta) R3(phi) J2000 (NAIF binary PCK type 2, body-fixed frame class 2).
    double a[3][3], b[3][3], c[3][3];
    rz(phi, a); rx(delta, b); rz(w, c);
    double ba[3][3];
    multiply(b, a, ba);
    multiply(c, ba, m);
    return true;
}

// MRO120F's Mars-fixed frame, from the PDS label of jgmro_120f_sha.tab (Konopliv et al. 2006 with the
// orientation updated in the MRO120F solution): rIN = Rz(-N) Rx(-J) Rz(-PSI) Rx(-I) Rz(-PHI) rBF, rIN in EME2000.
// N and J are fixed, PSI, I and PHI are the J2000 values and the secular rates the label states per day since
// J2000 (TDB); PHI adds the seasonal spin terms the label states for a Mars year and its halves, thirds and
// quarters from the epoch of January 1999. The nutation corrections of Konopliv et al. (2006) the label
// refers to are not in it and are not applied (below one arcsecond).
bool marsRotation(const timesys::Instant& tt, double m[3][3]) {
    constexpr double N = 3.37919183, J = 24.67682669;
    constexpr double PSI0 = 81.9683921212, PSI_RATE = -0.0000057829;
    constexpr double I0 = 25.1893814715, I_RATE = -0.000000001;
    constexpr double PHI0 = 133.386372559, PHI_RATE = 350.891985314;
    // Milliarcseconds: cosine and sine of one, two, three and four times the Mars year's angle.
    constexpr double SEASONAL[4][2] = {{488, -117}, {-108, -99}, {-16, -9}, {3, -2}};
    constexpr double MARS_YEAR_DAYS = 687.0;       // 360 deg / 191.39 deg per Earth year (the label's mean motion)
    constexpr double EPOCH_1999_DAYS = -365.5;     // 1999-01-01T00:00 relative to J2000.0
    const double T = tt.tdb().daysSinceJ2000();
    double phi = PHI0 + PHI_RATE * T;
    const double angle = 2 * 3.14159265358979323846264338327950288 * (T - EPOCH_1999_DAYS) / MARS_YEAR_DAYS;
    for (int k = 0; k < 4; ++k)
        phi += (SEASONAL[k][0] * std::cos((k + 1) * angle) + SEASONAL[k][1] * std::sin((k + 1) * angle)) / 3.6e6;
    const double psi = PSI0 + PSI_RATE * T, inclination = I0 + I_RATE * T;
    double bias[3][3];
    {
        double rp[3][3], rbp[3][3];
        eraBp00(2451545.0, 0.0, bias, rp, rbp);   // GCRF -> EME2000, constant
    }
    double r[3][3], tmp[3][3];
    rz(N * kDegToRad, r);                                              // EME2000 -> the first axes
    rx(J * kDegToRad, tmp); multiply(tmp, r, r);
    rz(psi * kDegToRad, tmp); multiply(tmp, r, r);
    rx(inclination * kDegToRad, tmp); multiply(tmp, r, r);
    rz(phi * kDegToRad, tmp); multiply(tmp, r, r);
    multiply(r, bias, m);
    return true;
}

} // namespace

bool supportedCentralBody(int naifId) { return naifId == MOON || naifId == MARS; }
const char* bodyName(int naifId) { return naifId == MOON ? "Moon" : naifId == MARS ? "Mars" : "Earth"; }
double bodyRadiusKm(int naifId) { return naifId == MOON ? 1737.4 : naifId == MARS ? 3396.19 : 6378.137; }
int kernelCenterId(int naifId) { return naifId == MARS ? 4 : naifId; }

double thirdBodyGmKm3S2(int naifId) {
    switch (naifId) {
        case 10: return 1.3271244004127942e11;
        case 1: return 2.2031868551400003e4;
        case 2: return 3.2485859200000000e5;
        case 399: return 3.9860043550702266e5;
        case 301: return 4.9028001184575496e3;
        case 4: return 4.2828375815756102e4;
        case 499: return 4.282837362069909e4;
        case 5: return 1.2671276409999998e8;
        case 6: return 3.7940584841799997e7;
        case 7: return 5.7945563999999985e6;
        case 8: return 6.8365271005803989e6;
        default: return -1;
    }
}

FieldInfo fieldInfo(int naifId) {
    FieldInfo info;
    Table t;
    if (!fieldTable(naifId, t)) return info;
    info.degree = int(u32(t.bytes + 8));
    info.gmKm3S2 = f64(t.bytes + 16);
    info.referenceRadiusKm = f64(t.bytes + 24);
    info.sourceDegree = int(f64(t.bytes + 32));
    info.name = naifId == MOON ? "GRGM660PRIM" : "MRO120F";
    return info;
}

const ExtendedGravityField& embeddedField(int naifId, int degree, int order, int tesseralDegree) {
    static ExtendedGravityField field;
    static int cachedBody = 0, cachedDegree = -1, cachedOrder = -1, cachedTesseral = -1;
    if (cachedBody == naifId && cachedDegree == degree && cachedOrder == order && cachedTesseral == tesseralDegree) return field;
    Table t;
    const FieldInfo info = fieldInfo(naifId);
    if (!fieldTable(naifId, t) || degree < 2 || degree > info.degree || order < 0 || order > degree) {
        field = ExtendedGravityField();   // an empty field: the caller validated, this is only a guard
        field.maxDegree = 0; field.maxOrder = 0;
        cachedBody = 0;
        return field;
    }
    const size_t rows = size_t(info.degree + 1) * size_t(info.degree + 2) / 2;
    const unsigned char* C = t.bytes + 40;
    const unsigned char* S = C + 4 * rows;
    field = ExtendedGravityField();
    field.model = GravityModelType::Custom;
    field.mu = info.gmKm3S2;
    field.referenceRadius = info.referenceRadiusKm;
    field.normalized = true;
    field.allocate(uint16_t(degree), uint16_t(order));
    for (int n = 2; n <= degree; ++n) {
        const size_t row = size_t(n) * size_t(n + 1) / 2;
        for (int m = 0; m <= std::min(n, order); ++m) {
            if (m >= 1 && n > tesseralDegree) continue;
            field.Cnm[n][m] = f32(C + 4 * (row + size_t(m)));
            field.Snm[n][m] = f32(S + 4 * (row + size_t(m)));
        }
    }
    cachedBody = naifId; cachedDegree = degree; cachedOrder = order; cachedTesseral = tesseralDegree;
    return field;
}

double marsDensityKgM3(double altitudeKm) {
    constexpr size_t count = sizeof kMarsBands / sizeof kMarsBands[0];
    if (!(altitudeKm > 0)) altitudeKm = 0;
    size_t band = 0;
    while (band + 1 < count && kMarsBands[band + 1].altitudeKm <= altitudeKm) ++band;
    const AtmosphereBand& b = kMarsBands[band];
    return b.densityKgM3 * std::exp(-(altitudeKm - b.altitudeKm) / b.scaleHeightKm);
}

double marsAltitudeKm(double x, double y, double z) {
    constexpr double a = 3396.19, b = 3376.20;
    const double r = std::sqrt(x * x + y * y + z * z);
    if (!(r > 0)) return -a;
    const double sinPhi = z / r, cosPhi = std::sqrt(x * x + y * y) / r;
    const double ellipsoid = a * b / std::sqrt(b * b * cosPhi * cosPhi + a * a * sinPhi * sinPhi);
    return r - ellipsoid;
}

double spinRateRadPerSec(int naifId) {
    constexpr double kMarsDegPerDay = 350.891985314;   // MRO120F, the label's dPHI/dt
    return naifId == MARS ? kMarsDegPerDay * kDegToRad / 86400.0 : 0.0;
}

bool orientationSpan(int naifId, double& startSeconds, double& stopSeconds) {
    if (naifId != MOON) return false;
    const Libration l = libration();
    // One day inside the records at each end, so that no stage of a step reads past them.
    startSeconds = l.start + 86400.0;
    stopSeconds = l.start + double(l.records) * l.length - 86400.0;
    return true;
}

bool orientationCovers(int naifId, const timesys::Instant& tt) {
    if (naifId == MARS) return true;
    if (naifId != MOON) return false;
    double start = 0, stop = 0;
    if (!orientationSpan(naifId, start, stop)) return false;
    const double et = tt.tdb().secondsSinceJ2000();
    return et >= start && et < stop;
}

bool bodyFixedRotation(int naifId, const timesys::Instant& tt, double m[3][3]) {
    const double identity[3][3] = {{1, 0, 0}, {0, 1, 0}, {0, 0, 1}};
    std::memcpy(m, identity, sizeof identity);
    if (naifId == MOON) return moonRotation(tt, m);
    if (naifId == MARS) return marsRotation(tt, m);
    return false;
}

} // namespace planetary
} // namespace astro
