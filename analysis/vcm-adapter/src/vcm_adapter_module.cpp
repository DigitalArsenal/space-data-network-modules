// analysis/vcm-adapter — Vector Covariance Messages in and out of the stack.
//
// read:  one VCM (the SP VECTOR/COVARIANCE MESSAGE V2.0, JANAP-128 narrative
//        lines prefixed "<>"; survey/legacy-messages/vcm in
//        spacedatastandards.org) ->
//          request            $PRW EXECUTION_REQUEST for propagator/hpop: the
//                             J2K state as EME2000, the VCM's force model, B,
//                             BDOT, AGOM and T as force values and, for the
//                             rows the VCM's covariance solved for, as
//                             DYNAMIC_PARAMETERS with a Cartesian SI
//                             INITIAL_COVARIANCE;
//          earth_orientation  $PRW EARTH_ORIENTATION: the VCM's single EOP
//                             point as daily $EOP rows over the arc;
//          vcm                the $VCM record;
//          report             JSON: every field read, the transformed
//                             covariance, and the UVW sigmas recomputed from it
//                             beside the ones the VCM states.
// write: a $PRW EXECUTION_RESULT whose FINAL_SAMPLE is in EME2000 with a
//        covariance over the state and DYNAMIC_PARAMETERS, plus a JSON header
//        (identity and model lines) -> VCM text.
//
// The covariance. A VCM's covariance is in SP's equinoctial elements
// (af, ag, L, n, chi, psi) and the model parameters after them (B, BDOT,
// AGOM, T, consider parameters), lower triangle by rows:
//   af  = e cos(w + fr W),  ag = e sin(w + fr W)
//   L   = M + w + fr W      (mean longitude, rad)
//   n   = mean motion       (rad per 1000 s, see below)
//   chi = tan^fr(i/2) sin W, psi = tan^fr(i/2) cos W
// with the retrograde factor fr = +1 (i <= 90 deg) or -1. The Cartesian
// covariance is J P J^T with J = d(r, v)/d(elements) evaluated exactly by
// forward-mode dual numbers through the closed-form conversion (Broucke &
// Cefola 1972; Vallado 2013 sec. 2.4.3), the parameter rows carried by J on
// one side.
//
// The format does not state the units of the covariance. Four messages
// settle the mean-motion row: the n row and column are relative, dn/n. With
// that reading the printed U, V, W sigmas of all four (the survey's sample,
// an ISS solution, and three SP messages on hand, which are not
// redistributed: a geostationary orbit, a GPS satellite and an orbit of
// eccentricity 0.59) are reproduced within 1 %; no absolute unit reproduces
// the eccentric message's radial sigma (rad/1000 s gives 36.9 m against a
// printed 45.8 m, rev/day 51.1 m; dn/n 45.8 m), and rad/1000 s, which fits
// the ISS sample alone, misses the geostationary and GPS radial sigmas by
// factors of 2.0 and 1.7. meanMotionUnit "fraction" is the default; the
// absolute units remain as options, and every read reports the recomputed
// sigmas so a wrong reading shows.
//
// The printed sigmas are those of the covariance times max(1, WTD RMS)^2:
// the eccentric message, with a weighted RMS of 0.86, matches unscaled, the
// others (1.09 to 1.15) only scaled.
//
// The parameter rows (B, BDOT, AGOM, T) cannot be checked against printed
// sigmas, which cover the elements only. As fractions of their values
// (parameterRows "fractional", the default, like the n row) the messages on
// hand give sigmas of 1.5 % to 9.7 %; as printed in m^2/kg ("absolute") they
// give 0.38 to 5.6 times the parameter itself, which fits of tens of metres
// would hardly leave. Against a precise orbit (the GPS message, one day,
// ESA's final orbit) the fractional reading's radial and in-track sigmas
// are about twice the errors; the absolute reading's, 7 to 20 times. B and AGOM rows are scaled by their values when
// fractional, BDOT and T rows are taken as printed, and every read reports
// the parameter sigmas it carried. write takes the same keys in its header
// and prints the rows back the same way.
//
// Pure compute: output bytes depend only on input bytes.

#include <algorithm>
#include <array>
#include <cctype>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include "space_data_module_invoke.h"

namespace {

constexpr double kPi = 3.14159265358979323846;
constexpr double kTwoPi = 2.0 * kPi;
constexpr double kArcsec = kPi / 648000.0;
constexpr double kEarthRate = 7.292115146706979e-5;  // rad/s, SP's EFG rate

// ---------------------------------------------------------------------------
// Forward-mode dual numbers with six directions: exact Jacobians of the
// element conversions.
struct Dual {
    double v = 0.0;
    std::array<double, 6> d{};
    Dual() = default;
    Dual(double value) : v(value) {}  // NOLINT: constants promote
};
inline Dual operator+(const Dual& a, const Dual& b) { Dual r(a.v + b.v); for (int i = 0; i < 6; ++i) r.d[i] = a.d[i] + b.d[i]; return r; }
inline Dual operator-(const Dual& a, const Dual& b) { Dual r(a.v - b.v); for (int i = 0; i < 6; ++i) r.d[i] = a.d[i] - b.d[i]; return r; }
inline Dual operator-(const Dual& a) { Dual r(-a.v); for (int i = 0; i < 6; ++i) r.d[i] = -a.d[i]; return r; }
inline Dual operator*(const Dual& a, const Dual& b) { Dual r(a.v * b.v); for (int i = 0; i < 6; ++i) r.d[i] = a.d[i] * b.v + a.v * b.d[i]; return r; }
inline Dual operator/(const Dual& a, const Dual& b) { Dual r(a.v / b.v); for (int i = 0; i < 6; ++i) r.d[i] = (a.d[i] * b.v - a.v * b.d[i]) / (b.v * b.v); return r; }
inline Dual chain(const Dual& a, double value, double slope) { Dual r(value); for (int i = 0; i < 6; ++i) r.d[i] = slope * a.d[i]; return r; }
inline Dual sin(const Dual& a) { return chain(a, std::sin(a.v), std::cos(a.v)); }
inline Dual cos(const Dual& a) { return chain(a, std::cos(a.v), -std::sin(a.v)); }
inline Dual sqrt(const Dual& a) { const double s = std::sqrt(a.v); return chain(a, s, 0.5 / s); }
inline Dual cbrt(const Dual& a) { const double c = std::cbrt(a.v); return chain(a, c, 1.0 / (3.0 * c * c)); }
inline Dual atan2(const Dual& y, const Dual& x) {
    Dual r(std::atan2(y.v, x.v));
    const double q = x.v * x.v + y.v * y.v;
    for (int i = 0; i < 6; ++i) r.d[i] = (x.v * y.d[i] - y.v * x.d[i]) / q;
    return r;
}
// The double overloads, so that the templates below find one function name
// for both scalars (unqualified lookup stops at this namespace).
inline double sin(double x) { return std::sin(x); }
inline double cos(double x) { return std::cos(x); }
inline double sqrt(double x) { return std::sqrt(x); }
inline double cbrt(double x) { return std::cbrt(x); }
inline double atan2(double y, double x) { return std::atan2(y, x); }
inline double value(double x) { return x; }
inline double value(const Dual& x) { return x.v; }

template <class S>
struct V3 { S x, y, z; };
template <class S> V3<S> add(const V3<S>& a, const V3<S>& b) { return {a.x + b.x, a.y + b.y, a.z + b.z}; }
template <class S> V3<S> scale(const V3<S>& a, const S& s) { return {a.x * s, a.y * s, a.z * s}; }
template <class S> S dot(const V3<S>& a, const V3<S>& b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
template <class S> V3<S> cross(const V3<S>& a, const V3<S>& b) { return {a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x}; }

// The equinoctial basis f, g (and w) for chi = p, psi = q.
template <class S>
void basis(const S& p, const S& q, int fr, V3<S>& f, V3<S>& g) {
    const S d = S(1.0) + p * p + q * q;
    f = {(S(1.0) - p * p + q * q) / d, S(2.0) * p * q / d, S(-2.0 * fr) * p / d};
    g = {S(2.0 * fr) * p * q / d, S(double(fr)) * (S(1.0) + p * p - q * q) / d, S(2.0) * q / d};
}

// (af, ag, L, n, chi, psi) -> (r km, v km/s); n in rad per nScale seconds.
template <class S>
void equinoctialToCartesian(const S e[6], double mu, int fr, double nScale, S rv[6]) {
    const S af = e[0], ag = e[1], L = e[2], chi = e[4], psi = e[5];
    const S n = e[3] / S(nScale);
    const S a = cbrt(S(mu) / (n * n));
    S F = L;  // eccentric longitude: L = F + ag cos F - af sin F
    for (int k = 0; k < 40; ++k) {
        const S residual = F + ag * cos(F) - af * sin(F) - L;
        F = F - residual / (S(1.0) - ag * sin(F) - af * cos(F));
        if (std::fabs(value(residual)) < 1e-15) break;
    }
    const S b = S(1.0) / (S(1.0) + sqrt(S(1.0) - af * af - ag * ag));
    const S cF = cos(F), sF = sin(F);
    const S x1 = a * ((S(1.0) - ag * ag * b) * cF + af * ag * b * sF - af);
    const S y1 = a * ((S(1.0) - af * af * b) * sF + af * ag * b * cF - ag);
    const S r = a * (S(1.0) - af * cF - ag * sF);
    const S k = n * a * a / r;
    const S xd = k * (af * ag * b * cF - (S(1.0) - ag * ag * b) * sF);
    const S yd = k * ((S(1.0) - af * af * b) * cF - af * ag * b * sF);
    V3<S> f, g;
    basis(chi, psi, fr, f, g);
    const V3<S> pos = add(scale(f, x1), scale(g, y1)), vel = add(scale(f, xd), scale(g, yd));
    rv[0] = pos.x; rv[1] = pos.y; rv[2] = pos.z; rv[3] = vel.x; rv[4] = vel.y; rv[5] = vel.z;
}

// (r km, v km/s) -> (af, ag, L, n, chi, psi); L in [0, 2 pi).
template <class S>
void cartesianToEquinoctial(const S rv[6], double mu, int fr, double nScale, S e[6]) {
    const V3<S> r{rv[0], rv[1], rv[2]}, v{rv[3], rv[4], rv[5]};
    const V3<S> h = cross(r, v);
    const S hn = sqrt(dot(h, h));
    const V3<S> w = scale(h, S(1.0) / hn);
    const S den = S(1.0) + S(double(fr)) * w.z;
    const S p = w.x / den, q = -w.y / den;
    V3<S> f, g;
    basis(p, q, fr, f, g);
    const S rn = sqrt(dot(r, r));
    const V3<S> ev = add(scale(r, S(-1.0) / rn), scale(cross(v, h), S(1.0 / mu)));
    const S af = dot(ev, f), ag = dot(ev, g);
    const S a = S(1.0) / (S(2.0) / rn - dot(v, v) / S(mu));
    const S n = sqrt(S(mu) / (a * a * a));
    const S x1 = dot(r, f), y1 = dot(r, g);
    const S root = sqrt(S(1.0) - af * af - ag * ag);
    const S b = S(1.0) / (S(1.0) + root);
    const S sF = ag + ((S(1.0) - ag * ag * b) * y1 - ag * af * b * x1) / (a * root);
    const S cF = af + ((S(1.0) - af * af * b) * x1 - ag * af * b * y1) / (a * root);
    const S F = atan2(sF, cF);
    S L = F + ag * cF - af * sF;
    if (value(L) < 0) L = L + S(kTwoPi);
    e[0] = af; e[1] = ag; e[2] = L; e[3] = n * S(nScale); e[4] = p; e[5] = q;
}

// d(rv)/d(e) and d(e)/d(rv), 6 x 6 row-major.
void jacobianToCartesian(const double e[6], double mu, int fr, double nScale, double out[36]) {
    Dual de[6], drv[6];
    for (int i = 0; i < 6; ++i) { de[i] = Dual(e[i]); de[i].d[i] = 1.0; }
    equinoctialToCartesian(de, mu, fr, nScale, drv);
    for (int i = 0; i < 6; ++i) for (int j = 0; j < 6; ++j) out[i * 6 + j] = drv[i].d[j];
}
void jacobianToEquinoctial(const double rv[6], double mu, int fr, double nScale, double out[36]) {
    Dual drv[6], de[6];
    for (int i = 0; i < 6; ++i) { drv[i] = Dual(rv[i]); drv[i].d[i] = 1.0; }
    cartesianToEquinoctial(drv, mu, fr, nScale, de);
    for (int i = 0; i < 6; ++i) for (int j = 0; j < 6; ++j) out[i * 6 + j] = de[i].d[j];
}

// P' = T P T^T for an n x n P where T acts on the first six rows/columns
// (identity on the parameters). t is 6 x 6.
std::vector<double> transform(const std::vector<double>& p, unsigned n, const double t[36]) {
    std::vector<double> big(n * n, 0.0), tmp(n * n, 0.0), out(n * n, 0.0);
    for (unsigned i = 0; i < n; ++i) big[i * n + i] = 1.0;
    for (unsigned i = 0; i < 6; ++i) for (unsigned j = 0; j < 6; ++j) big[i * n + j] = t[i * 6 + j];
    for (unsigned i = 0; i < n; ++i) for (unsigned j = 0; j < n; ++j) { double s = 0; for (unsigned k = 0; k < n; ++k) s += big[i * n + k] * p[k * n + j]; tmp[i * n + j] = s; }
    for (unsigned i = 0; i < n; ++i) for (unsigned j = 0; j < n; ++j) { double s = 0; for (unsigned k = 0; k < n; ++k) s += tmp[i * n + k] * big[j * n + k]; out[i * n + j] = s; }
    return out;
}

// U (radial), V (in-track: W x U), W (orbit normal) sigmas from a Cartesian
// 6 x 6 block of an n x n covariance (km units).
void uvwSigmasOf(const double rv[6], const std::vector<double>& p, unsigned n, double out[6]) {
    V3<double> r{rv[0], rv[1], rv[2]}, v{rv[3], rv[4], rv[5]};
    const double rn = std::sqrt(dot(r, r));
    const V3<double> u = scale(r, 1.0 / rn);
    V3<double> w = cross(r, v);
    w = scale(w, 1.0 / std::sqrt(dot(w, w)));
    const V3<double> vv = cross(w, u);
    const V3<double> axes[3] = {u, vv, w};
    for (int block = 0; block < 2; ++block)
        for (int k = 0; k < 3; ++k) {
            const double a[3] = {axes[k].x, axes[k].y, axes[k].z};
            double s = 0;
            for (int i = 0; i < 3; ++i) for (int j = 0; j < 3; ++j) s += a[i] * p[(3 * block + i) * n + 3 * block + j] * a[j];
            out[3 * block + k] = std::sqrt(std::max(0.0, s));
        }
}

// ---------------------------------------------------------------------------
// Text helpers.
std::string trim(const std::string& s) {
    size_t a = 0, b = s.size();
    while (a < b && (s[a] == ' ' || s[a] == '\t' || s[a] == '\r')) ++a;
    while (b > a && (s[b - 1] == ' ' || s[b - 1] == '\t' || s[b - 1] == '\r')) --b;
    return s.substr(a, b - a);
}
std::string upper(std::string s) { for (char& c : s) if (c >= 'a' && c <= 'z') c = char(c - 32); return s; }
// The text after `label` on the first line holding it, else "".
const std::string* lineWith(const std::vector<std::string>& lines, const char* label) {
    for (const auto& line : lines) if (line.find(label) != std::string::npos) return &line;
    return nullptr;
}
std::string after(const std::vector<std::string>& lines, const char* label) {
    const std::string* line = lineWith(lines, label);
    if (!line) return "";
    return line->substr(line->find(label) + std::strlen(label));
}
// The text after `label` up to the next of `stops` (or the line's end).
std::string field(const std::vector<std::string>& lines, const char* label, std::initializer_list<const char*> stops = {}) {
    std::string s = after(lines, label);
    size_t end = s.size();
    for (const char* stop : stops) { const size_t at = s.find(stop); if (at != std::string::npos) end = std::min(end, at); }
    return trim(s.substr(0, end));
}
bool numbers(const std::string& text, double* out, int count) {
    const char* p = text.c_str();
    for (int i = 0; i < count; ++i) {
        while (*p == ' ') ++p;
        char* end = nullptr;
        out[i] = std::strtod(p, &end);
        if (end == p || !std::isfinite(out[i])) return false;
        p = end;
    }
    return true;
}
bool number(const std::string& text, double* out) { return numbers(text, out, 1); }
bool onOff(const std::string& text) { return upper(trim(text)).rfind("ON", 0) == 0; }

std::string fmt(double x, const char* spec = "%.17g") {
    if (!std::isfinite(x)) return "null";
    char b[48];
    std::snprintf(b, sizeof b, spec, x);
    return b;
}
void jsonString(std::string& out, const std::string& s) {
    out += '"';
    for (unsigned char c : s) {
        if (c == '"' || c == '\\') { out += '\\'; out += char(c); }
        else if (c < 0x20) { char e[8]; std::snprintf(e, sizeof e, "\\u%04x", c); out += e; }
        else out += char(c);
    }
    out += '"';
}
void jsonArray(std::string& out, const double* v, size_t n) {
    out += '[';
    for (size_t i = 0; i < n; ++i) { if (i) out += ','; out += fmt(v[i]); }
    out += ']';
}

// ---------------------------------------------------------------------------
// Time: "yyyy ddd (dd mmm) hh:mm:ss.sss" (UTC).
struct Utc {
    int year = 0, month = 0, day = 0, hour = 0, minute = 0;
    double second = 0;
    bool ok = false;
};
int64_t daysFromCivil(int y, int m, int d) {
    y -= m <= 2;
    const int64_t era = (y >= 0 ? y : y - 399) / 400;
    const int64_t yoe = y - era * 400;
    const int64_t doy = (153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1;
    const int64_t doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    return era * 146097 + doe - 719468;  // days since 1970-01-01
}
void civilFromDays(int64_t z, int& y, int& m, int& d) {
    z += 719468;
    const int64_t era = (z >= 0 ? z : z - 146096) / 146097;
    const int64_t doe = z - era * 146097;
    const int64_t yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    const int64_t doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    const int64_t mp = (5 * doy + 2) / 153;
    d = int(doy - (153 * mp + 2) / 5 + 1);
    m = int(mp < 10 ? mp + 3 : mp - 9);
    y = int(yoe + era * 400 + (m <= 2));
}
Utc parseVcmTime(const std::string& text) {
    Utc t;
    int year = 0, doy = 0;
    if (std::sscanf(text.c_str(), "%d %d", &year, &doy) != 2) return t;
    const size_t close = text.find(')');
    if (close == std::string::npos) return t;
    std::string clock;
    for (char c : text.substr(close + 1)) if (c != ' ') clock += c;
    int h = 0, mi = 0;
    double s = 0;
    if (std::sscanf(clock.c_str(), "%d:%d:%lf", &h, &mi, &s) != 3) return t;
    if (doy < 1 || doy > 366 || h < 0 || h > 23 || mi < 0 || mi > 59 || s < 0 || s >= 61) return t;
    civilFromDays(daysFromCivil(year, 1, 1) + doy - 1, t.year, t.month, t.day);
    t.hour = h; t.minute = mi; t.second = s; t.ok = t.year == year;
    return t;
}
double unixSeconds(const Utc& t) { return double(daysFromCivil(t.year, t.month, t.day)) * 86400.0 + t.hour * 3600.0 + t.minute * 60.0 + t.second; }
Utc fromUnix(double u) {
    Utc t;
    const double dayF = std::floor(u / 86400.0);
    double rest = u - dayF * 86400.0;
    civilFromDays(int64_t(dayF), t.year, t.month, t.day);
    t.hour = int(rest / 3600.0); rest -= t.hour * 3600.0;
    t.minute = int(rest / 60.0); rest -= t.minute * 60.0;
    t.second = rest; t.ok = true;
    return t;
}
std::string iso(const Utc& t) {
    char b[48];
    std::snprintf(b, sizeof b, "%04d-%02d-%02dT%02d:%02d:%09.6f", t.year, t.month, t.day, t.hour, t.minute, t.second);
    return b;
}
// VCM form: "yyyy ddd (dd mmm) hh:mm:ss.sss".
std::string vcmTime(const Utc& t) {
    static const char* months[] = {"JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"};
    const int doy = int(daysFromCivil(t.year, t.month, t.day) - daysFromCivil(t.year, 1, 1)) + 1;
    char b[64];
    std::snprintf(b, sizeof b, "%04d %03d (%02d %s) %02d:%02d:%06.3f", t.year, doy, t.day, months[t.month - 1], t.hour, t.minute, t.second);
    return b;
}
double mjdOf(const Utc& t) { return unixSeconds(t) / 86400.0 + 40587.0; }

// ---------------------------------------------------------------------------
// The parsed VCM.
struct Vcm {
    std::string messageTime, center, satellite, intDes, name, epochText, geopotential, drag;
    Utc epoch, leap;
    double epochRev = 0;
    double j2kPos[3] = {}, j2kVel[3] = {};
    int zonals = 0, tesserals = 0;
    bool lunarSolar = false, srp = false, solidTides = false, inTrackThrust = false;
    double b = 0, bdot = 0, agom = 0, edr = 0, thrust = 0, cmOffset = 0;
    double f10 = 0, avgF10 = 0, avgAp = 0;
    double taiUtc = 0, ut1Utc = 0, ut1RateMsPerDay = 0, polarX = 0, polarY = 0;
    int nutationTerms = 0;
    std::string integratorMode, coordSys, partials, stepMode, fixedStep, stepSelection;
    double initialStep = 0, errorControl = 0;
    double sigmas[6] = {};
    unsigned n = 0;
    double weightedRms = 0;
    std::vector<double> covariance;  // n x n, full
};

double gmFor(const std::string& geopotential) {
    const std::string g = upper(geopotential);
    if (g.find("WGS-72") != std::string::npos || g.find("WGS72") != std::string::npos) return 398600.8;
    if (g.find("WGS-84") != std::string::npos || g.find("WGS84") != std::string::npos) return 398600.4418;
    if (g.find("GEM-T3") != std::string::npos) return 398600.436;
    return 398600.4415;  // EGM-96, JGM-2
}

std::string parseVcm(const std::string& text, Vcm& m) {
    std::vector<std::string> lines;
    size_t start = 0;
    while (start <= text.size()) {
        size_t end = text.find('\n', start);
        if (end == std::string::npos) end = text.size();
        std::string line = text.substr(start, end - start);
        const size_t mark = line.find("<>");
        if (mark != std::string::npos) lines.push_back(line.substr(mark + 2));
        start = end + 1;
    }
    if (!lineWith(lines, "VECTOR/COVARIANCE MESSAGE")) return "not-a-vcm: no \"VECTOR/COVARIANCE MESSAGE\" line";
    int messages = 0;
    for (const auto& line : lines) if (line.find("VECTOR/COVARIANCE MESSAGE") != std::string::npos) ++messages;
    if (messages != 1) return "one-message: read takes exactly one VCM";
    m.messageTime = field(lines, "MESSAGE TIME (UTC):", {"CENTER:"});
    m.center = field(lines, "CENTER:");
    m.satellite = field(lines, "SATELLITE NUMBER:", {"INT. DES.:"});
    m.intDes = field(lines, "INT. DES.:");
    m.name = field(lines, "COMMON NAME:");
    m.epochText = field(lines, "EPOCH TIME (UTC):", {"EPOCH REV:"});
    m.epoch = parseVcmTime(m.epochText);
    if (!m.epoch.ok) return "invalid-epoch: EPOCH TIME (UTC)";
    number(field(lines, "EPOCH REV:"), &m.epochRev);
    if (!numbers(after(lines, "J2K POS (KM):"), m.j2kPos, 3) || !numbers(after(lines, "J2K VEL (KM/S):"), m.j2kVel, 3))
        return "invalid-state: J2K POS (KM) and J2K VEL (KM/S) are required";
    const std::string geo = field(lines, "GEOPOTENTIAL:", {"DRAG:"});
    {   // "EGM-96 70Z,70T", "EGM-96  8Z, 8T" (SP pads the degrees to two places)
        size_t z = geo.find('Z');
        while (z != std::string::npos) {
            size_t d = z;
            while (d > 0 && geo[d - 1] == ' ') --d;
            const size_t digitsEnd = d;
            while (d > 0 && std::isdigit(static_cast<unsigned char>(geo[d - 1]))) --d;
            if (d < digitsEnd) { z = d; break; }
            z = geo.find('Z', z + 1);
        }
        if (z == std::string::npos) return "invalid-geopotential: expected <model> mmZ,nnT";
        m.geopotential = trim(geo.substr(0, z));
        std::string trunc;
        for (const char c : geo.substr(z)) if (c != ' ') trunc += c;
        if (std::sscanf(trunc.c_str(), "%dZ,%dT", &m.zonals, &m.tesserals) != 2) return "invalid-geopotential: expected <model> mmZ,nnT";
    }
    m.drag = field(lines, "DRAG:", {"LUNAR/SOLAR:"});
    m.lunarSolar = onOff(field(lines, "LUNAR/SOLAR:"));
    m.srp = onOff(field(lines, "SOLAR RAD PRESS:", {"SOLID EARTH TIDES:"}));
    m.solidTides = onOff(field(lines, "SOLID EARTH TIDES:", {"IN-TRACK THRUST:"}));
    m.inTrackThrust = onOff(field(lines, "IN-TRACK THRUST:"));
    if (!number(field(lines, "BALLISTIC COEF (M2/KG):", {"BDOT"}), &m.b)) return "invalid-ballistic-coefficient";
    number(field(lines, "BDOT (M2/KG-S):"), &m.bdot);
    number(field(lines, "SOLAR RAD PRESS COEFF (M2/KG):", {"EDR"}), &m.agom);
    number(field(lines, "EDR(W/KG):"), &m.edr);
    number(field(lines, "THRUST ACCEL (M/S2):", {"C.M."}), &m.thrust);
    number(field(lines, "C.M. OFFSET (M):"), &m.cmOffset);
    number(field(lines, "F10:", {"AVERAGE"}), &m.f10);
    number(field(lines, "AVERAGE F10:", {"AVERAGE AP:"}), &m.avgF10);
    number(field(lines, "AVERAGE AP:"), &m.avgAp);
    number(field(lines, "TAI-UTC (S):", {"UT1-UTC"}), &m.taiUtc);
    number(field(lines, "UT1-UTC (S):", {"UT1 RATE"}), &m.ut1Utc);
    number(field(lines, "UT1 RATE (MS/DAY):"), &m.ut1RateMsPerDay);
    {
        double pm[2] = {0, 0};
        if (numbers(field(lines, "POLAR MOT X,Y (ARCSEC):", {"IAU"}), pm, 2)) { m.polarX = pm[0]; m.polarY = pm[1]; }
        double terms = 0;
        if (number(field(lines, "NUTAT:", {"TERMS"}), &terms)) m.nutationTerms = int(terms);
    }
    m.leap = parseVcmTime(field(lines, "LEAP SECOND TIME (UTC):"));
    m.integratorMode = field(lines, "INTEGRATOR MODE:", {"COORD SYS:"});
    m.coordSys = field(lines, "COORD SYS:", {"PARTIALS:"});
    m.partials = field(lines, "PARTIALS:");
    m.stepMode = field(lines, "STEP MODE:", {"FIXED STEP:"});
    m.fixedStep = field(lines, "FIXED STEP:", {"STEP SIZE SELECTION:"});
    m.stepSelection = field(lines, "STEP SIZE SELECTION:");
    number(field(lines, "INITIAL STEP SIZE (S):", {"ERROR CONTROL:"}), &m.initialStep);
    number(field(lines, "ERROR CONTROL:"), &m.errorControl);
    numbers(after(lines, "VECTOR U,V,W SIGMAS (KM):"), m.sigmas, 3);
    numbers(after(lines, "VECTOR UD,VD,WD SIGMAS (KM/S):"), m.sigmas + 3, 3);
    // "COVARIANCE MATRIX (EQUINOCTIAL ELS): ( 7x 7) WTD RMS: 0.11498E+01"
    const std::string head = after(lines, "COVARIANCE MATRIX (EQUINOCTIAL ELS):");
    if (head.empty()) return "invalid-covariance: no COVARIANCE MATRIX (EQUINOCTIAL ELS) line";
    {
        std::string compact;
        for (char c : head) if (c != ' ') compact += c;
        int rows = 0, cols = 0;
        if (std::sscanf(compact.c_str(), "(%dx%d)", &rows, &cols) != 2 || rows != cols || rows < 0 || rows > 20)
            return "invalid-covariance: size must read (nn x nn), nn <= 20";
        m.n = unsigned(rows);
        number(field(lines, "WTD RMS:"), &m.weightedRms);
    }
    if (m.n > 0) {
        if (m.n < 6) return "invalid-covariance: fewer than the six elements";
        std::vector<double> values;
        bool collecting = false;
        for (const auto& line : lines) {
            if (line.find("COVARIANCE MATRIX (EQUINOCTIAL ELS):") != std::string::npos) { collecting = true; continue; }
            if (!collecting) continue;
            const char* p = line.c_str();
            for (;;) {
                while (*p == ' ') ++p;
                if (!*p) break;
                char* end = nullptr;
                const double x = std::strtod(p, &end);
                if (end == p) break;
                values.push_back(x);
                p = end;
            }
        }
        const size_t needed = size_t(m.n) * (m.n + 1) / 2;
        if (values.size() < needed) return "invalid-covariance: fewer values than its size";
        m.covariance.assign(size_t(m.n) * m.n, 0.0);
        size_t k = 0;
        for (unsigned i = 0; i < m.n; ++i)
            for (unsigned j = 0; j <= i; ++j) m.covariance[i * m.n + j] = m.covariance[j * m.n + i] = values[k++];
    }
    return "";
}

// ---------------------------------------------------------------------------
// Options (a flat JSON object; unknown keys are refused).
struct Options {
    double nScale = 1000.0;              // elements carry n in rad per nScale s
    std::string meanMotionUnit = "fraction";
    bool fractionalMeanMotion = true;    // the covariance's n row is dn/n
    bool scaleByWeightedRms = true;      // by max(1, WTD RMS)^2, as SP prints its sigmas
    double arcSeconds = 86400.0;
    std::string ephemerisSource = "JPL_SPK";
    bool fractionalParameterRows = true;
};
// A minimal reader for {"key": value, ...} with string, number and boolean
// values.
bool readFlatJson(const std::string& text, std::vector<std::pair<std::string, std::string>>& out, std::string& error) {
    size_t i = 0;
    auto ws = [&] { while (i < text.size() && (text[i] == ' ' || text[i] == '\n' || text[i] == '\r' || text[i] == '\t')) ++i; };
    auto str = [&](std::string& s) {
        if (i >= text.size() || text[i] != '"') return false;
        ++i;
        while (i < text.size() && text[i] != '"') {
            if (text[i] == '\\' && i + 1 < text.size()) { ++i; }
            s += text[i++];
        }
        if (i >= text.size()) return false;
        ++i;
        return true;
    };
    ws();
    if (i >= text.size() || text[i] != '{') { error = "options must be a JSON object"; return false; }
    ++i; ws();
    if (i < text.size() && text[i] == '}') return true;
    for (;;) {
        std::string key, value;
        ws();
        if (!str(key)) { error = "options: expected a key"; return false; }
        ws();
        if (i >= text.size() || text[i] != ':') { error = "options: expected ':'"; return false; }
        ++i; ws();
        if (i < text.size() && text[i] == '"') { if (!str(value)) { error = "options: bad string"; return false; } value = "\"" + value; }
        else { while (i < text.size() && text[i] != ',' && text[i] != '}') value += text[i++]; value = trim(value); }
        out.push_back({key, value});
        ws();
        if (i < text.size() && text[i] == ',') { ++i; continue; }
        if (i < text.size() && text[i] == '}') return true;
        error = "options: expected ',' or '}'";
        return false;
    }
}
const std::string* lookup(const std::vector<std::pair<std::string, std::string>>& kv, const char* key) {
    for (const auto& p : kv) if (p.first == key) return &p.second;
    return nullptr;
}
// SP's Fortran E format: 0.ddddddE+xx (a leading zero, `digits` digits).
std::string fortranE(double x, int digits) {
    char buf[48];
    if (x == 0 || !std::isfinite(x)) { std::snprintf(buf, sizeof buf, "0.%0*dE+00", digits, 0); return buf; }
    int e = int(std::floor(std::log10(std::fabs(x)))) + 1;
    const long long scale = std::llround(std::pow(10.0, digits));
    long long mantissa = std::llround(std::fabs(x) / std::pow(10.0, e) * double(scale));
    if (mantissa >= scale) { mantissa = scale / 10; ++e; }
    if (mantissa < scale / 10) { mantissa *= 10; --e; }
    std::snprintf(buf, sizeof buf, "%s0.%0*lldE%c%02d", x < 0 ? "-" : "", digits, mantissa, e < 0 ? '-' : '+', std::abs(e));
    return buf;
}

// The covariance's mean-motion row: "fraction" (dn/n, the default) or n in
// an absolute unit. Elements are carried with n in rad per `scale` seconds.
bool meanMotionRow(const std::string& unit, double& scale, bool& fraction) {
    fraction = unit == "fraction";
    if (fraction) { scale = 1000.0; return true; }
    if (unit == "rad/ks") scale = 1000.0;
    else if (unit == "rad/s") scale = 1.0;
    else if (unit == "rad/min") scale = 60.0;
    else if (unit == "rev/day") scale = 86400.0 / kTwoPi;
    else return false;
    return true;
}
std::string parseOptions(const plugin_input_frame_t* frame, Options& o) {
    if (!frame || !frame->payload || frame->payload_length == 0) return "";
    std::vector<std::pair<std::string, std::string>> kv;
    std::string error;
    if (!readFlatJson(std::string(reinterpret_cast<const char*>(frame->payload), frame->payload_length), kv, error)) return "invalid-options: " + error;
    for (const auto& p : kv) {
        const std::string& k = p.first;
        const std::string& v = p.second;
        if (k == "meanMotionUnit") {
            o.meanMotionUnit = v.empty() || v[0] != '"' ? v : v.substr(1);
            if (!meanMotionRow(o.meanMotionUnit, o.nScale, o.fractionalMeanMotion)) return "invalid-options: meanMotionUnit is fraction, rad/ks, rad/s, rad/min or rev/day";
        } else if (k == "scaleCovarianceByWeightedRms") {
            if (v != "true" && v != "false") return "invalid-options: scaleCovarianceByWeightedRms is a boolean";
            o.scaleByWeightedRms = v == "true";
        } else if (k == "arcSeconds") {
            if (!number(v, &o.arcSeconds) || !(o.arcSeconds > 0) || o.arcSeconds > 30 * 86400.0) return "invalid-options: arcSeconds in (0, 30 days]";
        } else if (k == "ephemerisSource") {
            o.ephemerisSource = v.empty() || v[0] != '"' ? v : v.substr(1);
        } else if (k == "parameterRows") {
            const std::string rows = v.empty() || v[0] != '"' ? v : v.substr(1);
            if (rows != "absolute" && rows != "fractional") return "invalid-options: parameterRows is absolute or fractional";
            o.fractionalParameterRows = rows == "fractional";
        } else {
            return "invalid-options: unknown key " + k;
        }
    }
    return "";
}

// ---------------------------------------------------------------------------
// Builders.
std::vector<uint8_t> finishPrw(::flatbuffers::FlatBufferBuilder& fbb, ::flatbuffers::Offset<PRW> root) {
    FinishSizePrefixedPRWBuffer(fbb, root);
    return std::vector<uint8_t>(fbb.GetBufferPointer(), fbb.GetBufferPointer() + fbb.GetSize());
}
std::unique_ptr<TIMInstantT> isoInstant(const std::string& text) {
    auto t = std::make_unique<TIMInstantT>();
    t->TIME_SYSTEM = timingStandard::UTC;
    t->EPOCH_FORMAT = timEpochRepresentation::ISO8601;
    t->ISO8601 = text;
    return t;
}
std::unique_ptr<RFMCoordinateSystemT> eme2000() {
    auto c = std::make_unique<RFMCoordinateSystemT>();
    c->NAME = "EME2000";
    c->AXIS_TYPE = rfmAxisType::MEAN_EQUATOR_EQUINOX_J2000;
    c->AXIS_REFERENCE_BODY_ID = 399;
    c->ORIGIN = std::make_unique<RFMOriginT>();
    c->ORIGIN->KIND = rfmOriginKind::CELESTIAL_BODY;
    c->ORIGIN->CELESTIAL_BODY_ID = 399;
    return c;
}
std::unique_ptr<FRMVector3T> vector3(const double v[3], double scale) {
    auto out = std::make_unique<FRMVector3T>();
    out->X = v[0] * scale; out->Y = v[1] * scale; out->Z = v[2] * scale;
    return out;
}
double kpFromAp(double ap) {
    static const double table[][2] = {{0, 0}, {2, 0.33}, {3, 0.67}, {4, 1}, {5, 1.33}, {6, 1.67}, {7, 2}, {9, 2.33}, {12, 2.67}, {15, 3}, {18, 3.33}, {22, 3.67}, {27, 4}, {32, 4.33}, {39, 4.67}, {48, 5}, {56, 5.33}, {67, 5.67}, {80, 6}, {94, 6.33}, {111, 6.67}, {132, 7}, {154, 7.33}, {179, 7.67}, {207, 8}, {236, 8.33}, {300, 8.67}, {400, 9}};
    const int n = int(sizeof table / sizeof table[0]);
    if (ap <= 0) return 0;
    for (int i = 1; i < n; ++i)
        if (ap <= table[i][0]) return table[i - 1][1] + (table[i][1] - table[i - 1][1]) * (ap - table[i - 1][0]) / (table[i][0] - table[i - 1][0]);
    return 9;
}

struct Parameters {
    std::vector<prwDynamicParameter> list;
    std::vector<unsigned> rows;  // VCM covariance row of each
};
// The VCM rows after the six elements: 6 B, 7 BDOT, 8 AGOM, 9 T, then
// consider parameters. A row is carried when the fit solved for it (nonzero
// variance) and its force is on.
Parameters solvedParameters(const Vcm& m, std::vector<std::string>& notes) {
    Parameters p;
    const prwDynamicParameter kinds[4] = {prwDynamicParameter::DRAG_AREA_OVER_MASS, prwDynamicParameter::DRAG_AREA_OVER_MASS_RATE,
                                          prwDynamicParameter::SRP_AREA_OVER_MASS, prwDynamicParameter::IN_TRACK_ACCELERATION};
    const char* names[4] = {"B", "BDOT", "AGOM", "T"};
    for (unsigned k = 0; k < 4 && 6 + k < m.n; ++k) {
        const double variance = m.covariance[(6 + k) * m.n + 6 + k];
        if (!(variance > 0)) continue;
        const bool on = k == 0 ? m.b > 0 : k == 1 ? m.b > 0 : k == 2 ? m.srp : m.inTrackThrust;
        if (!on) { notes.push_back(std::string(names[k]) + " has a variance but its force is off in the VCM; the row is dropped"); continue; }
        p.list.push_back(kinds[k]);
        p.rows.push_back(6 + k);
    }
    if (m.n > 10) notes.push_back(std::to_string(m.n - 10) + " consider parameter row(s) dropped: they have no PRW force");
    return p;
}

}  // namespace

extern "C" {

int read(void) {
    const int32_t messageIndex = plugin_find_input_index("message", 0);
    const plugin_input_frame_t* frame = messageIndex >= 0 ? plugin_get_input_frame(uint32_t(messageIndex)) : nullptr;
    if (!frame || !frame->payload || frame->payload_length == 0) {
        plugin_set_error("missing-message", "read requires the VCM text on port \"message\".");
        return 400;
    }
    Options o;
    const int32_t optionsIndex = plugin_find_input_index("options", 0);
    if (std::string error = parseOptions(optionsIndex >= 0 ? plugin_get_input_frame(uint32_t(optionsIndex)) : nullptr, o); !error.empty()) {
        plugin_set_error("invalid-options", error.c_str());
        return 400;
    }
    Vcm m;
    if (std::string error = parseVcm(std::string(reinterpret_cast<const char*>(frame->payload), frame->payload_length), m); !error.empty()) {
        plugin_set_error("invalid-vcm", error.c_str());
        return 400;
    }
    std::vector<std::string> notes;
    const double mu = gmFor(m.geopotential);
    const double rv[6] = {m.j2kPos[0], m.j2kPos[1], m.j2kPos[2], m.j2kVel[0], m.j2kVel[1], m.j2kVel[2]};
    // Retrograde factor from the state's inclination.
    const V3<double> h = cross(V3<double>{rv[0], rv[1], rv[2]}, V3<double>{rv[3], rv[4], rv[5]});
    const int fr = h.z >= 0 ? 1 : -1;
    double elements[6];
    cartesianToEquinoctial(rv, mu, fr, o.nScale, elements);
    double back[6];
    equinoctialToCartesian(elements, mu, fr, o.nScale, back);
    double roundTrip = 0;
    for (int i = 0; i < 6; ++i) roundTrip = std::max(roundTrip, std::fabs(back[i] - rv[i]));

    // Cartesian covariance (km, km/s, parameter units as the VCM prints them).
    const Parameters parameters = solvedParameters(m, notes);
    const unsigned np = unsigned(parameters.list.size()), n = 6 + np;
    std::vector<double> cartesian, eq6(36, 0.0);
    double recomputed[6] = {};
    const double rms = m.weightedRms > 0 ? m.weightedRms : 1.0;
    const double printedScale = std::max(1.0, rms) * std::max(1.0, rms);  // SP's sigmas: covariance times max(1, RMS)^2
    const double variance = o.scaleByWeightedRms ? printedScale : 1.0;
    // Parameter rows in the force's own units: as printed, or B and AGOM as
    // fractions of their values.
    std::vector<double> rowScale(n, 1.0);
    if (o.fractionalMeanMotion) rowScale[3] = elements[3];  // dn/n -> dn in rad per nScale s
    for (unsigned k = 0; k < np; ++k) {
        const unsigned row = parameters.rows[k];
        if (o.fractionalParameterRows && row == 6) rowScale[6 + k] = m.b;
        if (o.fractionalParameterRows && row == 8) rowScale[6 + k] = m.agom;
    }
    if (o.fractionalParameterRows) notes.push_back("parameter rows read as fractions: B and AGOM rows scaled by their values; BDOT and T rows as printed");
    std::vector<double> parameterSigma(np, 0.0);
    if (m.n >= 6) {
        std::vector<double> reduced(n * n, 0.0);
        std::vector<unsigned> rows{0, 1, 2, 3, 4, 5};
        rows.insert(rows.end(), parameters.rows.begin(), parameters.rows.end());
        for (unsigned i = 0; i < n; ++i) for (unsigned j = 0; j < n; ++j) reduced[i * n + j] = m.covariance[rows[i] * m.n + rows[j]] * variance * rowScale[i] * rowScale[j];
        for (unsigned k = 0; k < np; ++k) parameterSigma[k] = std::sqrt(reduced[(6 + k) * n + 6 + k]);
        double j6[36];
        jacobianToCartesian(elements, mu, fr, o.nScale, j6);
        cartesian = transform(reduced, n, j6);
        // The VCM prints its sigmas from the covariance times the weighted RMS.
        std::vector<double> asPrinted = cartesian;
        if (!o.scaleByWeightedRms) for (double& x : asPrinted) x *= printedScale;
        uvwSigmasOf(rv, asPrinted, n, recomputed);
    } else {
        notes.push_back("the VCM carries no covariance (0x0)");
    }

    // ---- request ----
    auto request = std::make_unique<PRWExecutionRequestT>();
    request->INITIAL = std::make_unique<PRWResidentStateT>();
    auto& initial = *request->INITIAL;
    initial.STATE = std::make_unique<FRMStateVectorT>();
    initial.STATE->REPRESENTATION = frmStateRepresentation::CARTESIAN;
    initial.STATE->POSITION = vector3(m.j2kPos, 1000.0);
    initial.STATE->VELOCITY = vector3(m.j2kVel, 1000.0);
    initial.STATE->COORDINATE_SYSTEM_NAME = "EME2000";
    initial.STATE->EPOCH = iso(m.epoch);
    initial.STATE->EPOCH_TIME_SYSTEM = "UTC";
    initial.COORDINATE_SYSTEM = eme2000();
    initial.HAS_MASS_KG = true;
    initial.MASS_KG = 1000.0;
    const Utc target = fromUnix(unixSeconds(m.epoch) + o.arcSeconds);
    request->TARGET_EPOCH = isoInstant(iso(target));
    request->INTEGRATOR = std::make_unique<PRWIntegratorSettingsT>();
    auto& integrator = *request->INTEGRATOR;
    integrator.ALGORITHM = prwSolverAlgorithm::RK78;
    integrator.INITIAL_STEP_SECONDS = 30.0;
    integrator.MINIMUM_STEP_SECONDS = 1e-3;
    integrator.MAXIMUM_STEP_SECONDS = 300.0;
    integrator.ABSOLUTE_TOLERANCES.assign(6, 1e-10);
    integrator.RELATIVE_TOLERANCE = 1e-13;
    integrator.MAXIMUM_STEPS = 1000000;
    request->FORCES = std::make_unique<PRWForceConfigurationT>();
    auto& forces = *request->FORCES;
    forces.GRAVITATIONAL_PARAMETER = mu * 1e9;
    forces.ENABLE_POINT_MASS = true;
    forces.ENABLE_J2 = false;  // the zonal flags gate only INFER_FLAGS
    forces.ENABLE_J3 = false;
    forces.ENABLE_J4 = false;
    forces.ENABLE_HIGHER_ZONALS = false;
    const std::string geo = upper(m.geopotential);
    if (m.zonals >= 2) {
        forces.GRAVITY_CHOICE = geo.find("EGM-96") != std::string::npos || geo.find("EGM96") != std::string::npos ? prwGravitySelection::EGM96 : prwGravitySelection::EGM2008;
        if (forces.GRAVITY_CHOICE == prwGravitySelection::EGM2008) notes.push_back("geopotential " + m.geopotential + " is not embedded; EGM2008 stands in");
        forces.MAXIMUM_DEGREE = uint16_t(std::max(m.zonals, m.tesserals));
        forces.HAS_MAXIMUM_DEGREE = true;
        forces.MAXIMUM_ORDER = uint16_t(m.tesserals);
        forces.HAS_MAXIMUM_ORDER = true;
        if (m.tesserals < m.zonals) { forces.MAXIMUM_TESSERAL_DEGREE = uint16_t(m.tesserals); forces.HAS_MAXIMUM_TESSERAL_DEGREE = true; }
    } else {
        forces.GRAVITY_CHOICE = prwGravitySelection::POINT_MASS;
    }
    if (m.lunarSolar) { forces.ENABLE_THIRD_BODY = true; forces.THIRD_BODY_IDS = {10, 301}; }
    forces.INITIAL_MASS_KG = 1000.0;
    forces.AREA_M2 = 1.0;
    // Cd A/m = B and Cr A/m = AGOM with m = 1000 kg and A = 1 m^2.
    forces.DRAG_COEFFICIENT = m.b * 1000.0;
    forces.REFLECTIVITY_COEFFICIENT = m.agom * 1000.0;
    forces.ENABLE_SRP = m.srp && m.agom > 0;
    if (m.srp && !(m.agom > 0)) notes.push_back("SOLAR RAD PRESS is ON with a zero coefficient; radiation pressure left off");
    const std::string drag = upper(m.drag);
    forces.ENABLE_DRAG = m.b > 0 && drag.find("NONE") == std::string::npos && drag.find("OFF") == std::string::npos;
    if (drag.find("JB") != std::string::npos) {
        forces.ATMOSPHERE_MODEL = prwAtmosphereFamily::JB2008;
        notes.push_back("drag " + m.drag + " runs JB2008, which reads the jb2008_indices input (SET SOLFSMY/DTCFILE rows); a VCM does not carry them");
    } else if (drag.find("JAC") != std::string::npos) {
        forces.ATMOSPHERE_MODEL = prwAtmosphereFamily::JACCHIA_ROBERTS;
    } else {
        forces.ATMOSPHERE_MODEL = prwAtmosphereFamily::NRLMSISE00;
    }
    forces.EPHEMERIS_SOURCE = o.ephemerisSource;
    if (forces.ENABLE_DRAG && forces.ATMOSPHERE_MODEL != prwAtmosphereFamily::JB2008) {
        forces.WEATHER = std::make_unique<PRWSpaceWeatherT>();
        forces.WEATHER->EPOCH = isoInstant(iso(m.epoch));
        forces.WEATHER->F107 = m.f10;
        forces.WEATHER->F107_AVERAGE = m.avgF10;
        forces.WEATHER->AP_INDEX = m.avgAp;
        forces.WEATHER->KP_INDEX = kpFromAp(m.avgAp);
    }
    if (m.solidTides) forces.SOLID_TIDES = prwSolidTideModel::IERS_2010;
    if (m.inTrackThrust) { forces.IN_TRACK_ACCELERATION_M_S2 = m.thrust; forces.HAS_IN_TRACK_ACCELERATION_M_S2 = true; }
    if (m.bdot != 0 && forces.ENABLE_DRAG) { forces.DRAG_AREA_OVER_MASS_RATE_M2_KG_S = m.bdot; forces.HAS_DRAG_AREA_OVER_MASS_RATE_M2_KG_S = true; }
    request->INCLUDE_STM = true;
    request->STM_TECHNIQUE = prwDerivativeTechnique::ANALYTIC;
    request->DENSITY_TREATMENT = forces.ENABLE_DRAG ? prwDensityTreatment::FINITE_DIFFERENCE : prwDensityTreatment::NEGLECTED;
    // Parameters whose force ended up off are not carried either.
    std::vector<prwDynamicParameter> kept;
    std::vector<unsigned> keptIndex;
    for (unsigned k = 0; k < np; ++k) {
        const auto p = parameters.list[k];
        const bool on = (p == prwDynamicParameter::DRAG_AREA_OVER_MASS || p == prwDynamicParameter::DRAG_AREA_OVER_MASS_RATE) ? forces.ENABLE_DRAG
                      : p == prwDynamicParameter::SRP_AREA_OVER_MASS ? forces.ENABLE_SRP : true;
        if (on) { kept.push_back(p); keptIndex.push_back(6 + k); }
    }
    for (const auto p : kept) request->DYNAMIC_PARAMETERS.push_back(p);
    if (!cartesian.empty()) {
        std::vector<unsigned> idx{0, 1, 2, 3, 4, 5};
        idx.insert(idx.end(), keptIndex.begin(), keptIndex.end());
        const unsigned nk = unsigned(idx.size());
        request->INITIAL_COVARIANCE = std::make_unique<PRWStateMatrixT>();
        request->INITIAL_COVARIANCE->DIMENSION = nk;
        for (unsigned i = 0; i < nk; ++i)
            for (unsigned j = 0; j < nk; ++j)
                request->INITIAL_COVARIANCE->VALUES.push_back(cartesian[idx[i] * n + idx[j]] * (i < 6 ? 1000.0 : 1.0) * (j < 6 ? 1000.0 : 1.0));
    }
    std::vector<uint8_t> requestBytes;
    {
        ::flatbuffers::FlatBufferBuilder fbb;
        PRWT prw;
        prw.EXECUTION_REQUEST = std::move(request);
        requestBytes = finishPrw(fbb, PRW::Pack(fbb, &prw));
    }

    // ---- earth_orientation: daily rows from the day before the epoch to the
    // day after the arc; UT1 - UTC moves at the stated rate and steps at the
    // stated leap second; polar motion is held. ----
    std::vector<uint8_t> eopBytes;
    {
        auto table = std::make_unique<PRWEarthOrientationT>();
        const double epochMjd = mjdOf(m.epoch);
        const double leapMjd = m.leap.ok ? mjdOf(m.leap) + 1.0 / 86400.0 : 1e9;
        const int first = int(std::floor(epochMjd)) - 1, last = int(std::floor(epochMjd + o.arcSeconds / 86400.0)) + 2;
        for (int day = first; day <= last; ++day) {
            auto row = std::make_unique<EOPT>();
            int y = 0, mo = 0, d = 0;
            civilFromDays(int64_t(day) - 40587, y, mo, d);
            char date[32];
            std::snprintf(date, sizeof date, "%04d-%02d-%02dT00:00:00.000Z", y, mo, d);
            row->DATE = date;
            row->MJD = uint32_t(day);
            const bool afterLeap = day >= leapMjd && leapMjd > epochMjd;
            const double ut1 = m.ut1Utc + m.ut1RateMsPerDay * 1e-3 * (day - epochMjd) + (afterLeap ? 1.0 : 0.0);
            row->UT1_MINUS_UTC_SECONDS = float(ut1);
            row->UT1_MINUS_UTC_SECONDS_HP = ut1;
            row->X_POLE_WANDER_RADIANS = float(m.polarX * kArcsec);
            row->X_POLE_WANDER_RADIANS_HP = m.polarX * kArcsec;
            row->Y_POLE_WANDER_RADIANS = float(m.polarY * kArcsec);
            row->Y_POLE_WANDER_RADIANS_HP = m.polarY * kArcsec;
            row->LENGTH_OF_DAY_CORRECTION_SECONDS = float(-m.ut1RateMsPerDay * 1e-3);
            row->LENGTH_OF_DAY_CORRECTION_SECONDS_HP = -m.ut1RateMsPerDay * 1e-3;
            row->TAI_MINUS_UTC_SECONDS = uint16_t(m.taiUtc + (afterLeap ? 1.0 : 0.0));
            row->DATA_TYPE = DataType::PREDICTED;
            row->SERIES = eopSeries::OTHER;
            row->DATA_SET_CID = "VCM " + m.satellite + " " + iso(m.epoch);
            table->ROWS.push_back(std::move(row));
        }
        ::flatbuffers::FlatBufferBuilder fbb;
        PRWT prw;
        prw.EARTH_ORIENTATION = std::move(table);
        eopBytes = finishPrw(fbb, PRW::Pack(fbb, &prw));
    }

    // ---- vcm ($VCM) ----
    std::vector<uint8_t> vcmBytes;
    {
        VCMT v;
        v.CREATION_DATE = m.messageTime;
        v.ORIGINATOR = m.center;
        v.OBJECT_NAME = m.name;
        v.OBJECT_ID = m.intDes;
        v.CENTER_NAME = "EARTH";
        v.REF_FRAME = "EME2000";
        v.TIME_SYSTEM = "UTC";
        v.STATE_VECTOR = std::make_unique<VCMStateVectorT>();
        v.STATE_VECTOR->EPOCH = iso(m.epoch);
        v.STATE_VECTOR->X = m.j2kPos[0]; v.STATE_VECTOR->Y = m.j2kPos[1]; v.STATE_VECTOR->Z = m.j2kPos[2];
        v.STATE_VECTOR->X_DOT = m.j2kVel[0]; v.STATE_VECTOR->Y_DOT = m.j2kVel[1]; v.STATE_VECTOR->Z_DOT = m.j2kVel[2];
        v.EQUINOCTIAL_ELEMENTS = std::make_unique<equinoctialElementsT>();
        v.EQUINOCTIAL_ELEMENTS->AF = elements[0];
        v.EQUINOCTIAL_ELEMENTS->AG = elements[1];
        v.EQUINOCTIAL_ELEMENTS->L = elements[2];
        v.EQUINOCTIAL_ELEMENTS->N = std::cbrt(mu / std::pow(elements[3] / o.nScale, 2));  // the schema's N: semi-major axis, km
        v.EQUINOCTIAL_ELEMENTS->CHI = elements[4];
        v.EQUINOCTIAL_ELEMENTS->PSI = elements[5];
        v.GM = mu;
        v.ATMOSPHERIC_MODEL_DATA = std::make_unique<VCMAtmosphericModelDataT>();
        v.ATMOSPHERIC_MODEL_DATA->ATMOSPHERIC_MODEL = drag.find("JB") != std::string::npos ? atmosphericSource::JB2008
                                                    : drag.find("JAC") != std::string::npos ? atmosphericSource::JACCHIA_70
                                                    : drag.find("MSIS") != std::string::npos ? atmosphericSource::NRLMSISE_00 : atmosphericSource::NONE;
        v.ATMOSPHERIC_MODEL_DATA->GEOPOTENTIAL_MODEL = geo.find("EGM-96") != std::string::npos || geo.find("EGM96") != std::string::npos ? geopotentialSource::EGM96
                                                     : geo.find("WGS-84") != std::string::npos ? geopotentialSource::WGS84
                                                     : geo.find("JGM-2") != std::string::npos ? geopotentialSource::JGM2
                                                     : geo.find("GEM-T3") != std::string::npos ? geopotentialSource::GEMT3 : geopotentialSource::NONE;
        v.ATMOSPHERIC_MODEL_DATA->LUNAR_SOLAR_PERTURBATION = m.lunarSolar ? perturbationStatus::ON : perturbationStatus::OFF;
        v.ATMOSPHERIC_MODEL_DATA->SOLAR_RADIATION_PRESSURE = m.srp ? perturbationStatus::ON : perturbationStatus::OFF;
        v.ATMOSPHERIC_MODEL_DATA->SRP_MODEL = m.srp ? solarRadiationPressureModel::SPHERICAL_MODEL : solarRadiationPressureModel::NONE;
        v.UVW_SIGMAS = std::make_unique<uvwSigmasT>();
        v.UVW_SIGMAS->U_SIGMA = m.sigmas[0]; v.UVW_SIGMAS->V_SIGMA = m.sigmas[1]; v.UVW_SIGMAS->W_SIGMA = m.sigmas[2];
        v.UVW_SIGMAS->UD_SIGMA = m.sigmas[3]; v.UVW_SIGMAS->VD_SIGMA = m.sigmas[4]; v.UVW_SIGMAS->WD_SIGMA = m.sigmas[5];
        v.SRP = m.srp ? perturbationStatus::ON : perturbationStatus::OFF;
        v.NORAD_CAT_ID = uint32_t(std::strtoul(m.satellite.c_str(), nullptr, 10));
        v.REV_AT_EPOCH = m.epochRev;
        v.COV_REFERENCE_FRAME = "EME2000";
        if (!cartesian.empty())
            for (unsigned i = 0; i < 6; ++i) for (unsigned j = 0; j <= i; ++j) v.COVARIANCE.push_back(cartesian[i * n + j]);
        v.USER_DEFINED_EARTH_MODEL = m.geopotential + " " + std::to_string(m.zonals) + "Z," + std::to_string(m.tesserals) + "T";
        ::flatbuffers::FlatBufferBuilder fbb;
        FinishSizePrefixedVCMBuffer(fbb, VCM::Pack(fbb, &v));
        vcmBytes.assign(fbb.GetBufferPointer(), fbb.GetBufferPointer() + fbb.GetSize());
    }

    // ---- report ----
    std::string r = "{\"satellite\":";
    jsonString(r, m.satellite);
    r += ",\"internationalDesignator\":"; jsonString(r, m.intDes);
    r += ",\"commonName\":"; jsonString(r, m.name);
    r += ",\"center\":"; jsonString(r, m.center);
    r += ",\"epochUtc\":"; jsonString(r, iso(m.epoch));
    r += ",\"targetUtc\":"; jsonString(r, iso(target));
    r += ",\"j2kPositionKm\":"; jsonArray(r, m.j2kPos, 3);
    r += ",\"j2kVelocityKmS\":"; jsonArray(r, m.j2kVel, 3);
    r += ",\"geopotential\":"; jsonString(r, m.geopotential);
    r += ",\"zonals\":" + std::to_string(m.zonals) + ",\"tesserals\":" + std::to_string(m.tesserals);
    r += ",\"drag\":"; jsonString(r, m.drag);
    r += std::string(",\"lunarSolar\":") + (m.lunarSolar ? "true" : "false") + ",\"solarRadiationPressure\":" + (m.srp ? "true" : "false") +
         ",\"solidEarthTides\":" + (m.solidTides ? "true" : "false") + ",\"inTrackThrust\":" + (m.inTrackThrust ? "true" : "false");
    r += ",\"ballisticCoefficientM2Kg\":" + fmt(m.b) + ",\"bdotM2KgS\":" + fmt(m.bdot) + ",\"agomM2Kg\":" + fmt(m.agom) +
         ",\"thrustAccelerationMS2\":" + fmt(m.thrust) + ",\"edrWKg\":" + fmt(m.edr) + ",\"centerOfMassOffsetM\":" + fmt(m.cmOffset);
    r += ",\"f10\":" + fmt(m.f10) + ",\"averageF10\":" + fmt(m.avgF10) + ",\"averageAp\":" + fmt(m.avgAp);
    r += ",\"taiMinusUtcS\":" + fmt(m.taiUtc) + ",\"ut1MinusUtcS\":" + fmt(m.ut1Utc) + ",\"ut1RateMsPerDay\":" + fmt(m.ut1RateMsPerDay) +
         ",\"polarMotionArcsec\":[" + fmt(m.polarX) + "," + fmt(m.polarY) + "],\"nutationTerms\":" + std::to_string(m.nutationTerms);
    r += ",\"leapSecondUtc\":"; jsonString(r, m.leap.ok ? iso(m.leap) : "");
    r += ",\"integrator\":{\"mode\":"; jsonString(r, m.integratorMode);
    r += ",\"coordinateSystem\":"; jsonString(r, m.coordSys);
    r += ",\"partials\":"; jsonString(r, m.partials);
    r += ",\"initialStepS\":" + fmt(m.initialStep) + ",\"errorControl\":" + fmt(m.errorControl) + "}";
    r += ",\"gmKm3S2\":" + fmt(mu) + ",\"retrogradeFactor\":" + std::to_string(fr) + ",\"meanMotionUnit\":";
    jsonString(r, o.meanMotionUnit);
    r += ",\"equinoctial\":"; jsonArray(r, elements, 6);
    r += ",\"equinoctialRoundTripKm\":" + fmt(roundTrip);
    r += ",\"covarianceSize\":" + std::to_string(m.n) + ",\"weightedRms\":" + fmt(m.weightedRms);
    r += std::string(",\"covarianceScaledByWeightedRms\":") + (o.scaleByWeightedRms ? "true" : "false") + ",\"covarianceScale\":" + fmt(variance);
    r += ",\"equinoctialMeanMotionUnit\":\"rad/ks\"";
    r += ",\"dynamicParameters\":[";
    for (size_t i = 0; i < kept.size(); ++i) { if (i) r += ','; jsonString(r, EnumNameprwDynamicParameter(kept[i])); }
    r += "],\"parameterRows\":";
    jsonString(r, o.fractionalParameterRows ? "fractional" : "absolute");
    r += ",\"parameterSigmas\":[";
    {
        const char* names[4] = {"B", "BDOT", "AGOM", "T"};
        const double values[4] = {m.b, m.bdot, m.agom, m.thrust};
        const char* units[4] = {"m2/kg", "m2/kg/s", "m2/kg", "m/s2"};
        for (unsigned k = 0; k < np; ++k) {
            const unsigned slot = parameters.rows[k] - 6;
            if (k) r += ',';
            r += "{\"name\":"; jsonString(r, names[slot]);
            r += ",\"unit\":"; jsonString(r, units[slot]);
            r += ",\"value\":" + fmt(values[slot]) + ",\"sigma\":" + fmt(parameterSigma[k]) + "}";
        }
    }
    r += "],\"cartesianCovarianceKm\":";
    if (cartesian.empty()) r += "null"; else jsonArray(r, cartesian.data(), cartesian.size());
    r += ",\"statedUvwSigmasKm\":"; jsonArray(r, m.sigmas, 6);
    r += ",\"recomputedUvwSigmasKm\":"; jsonArray(r, recomputed, 6);
    r += ",\"notes\":[";
    for (size_t i = 0; i < notes.size(); ++i) { if (i) r += ','; jsonString(r, notes[i]); }
    r += "]}";

    if (plugin_push_output_ex("request", "PRW.fbs", "$PRW", PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, "PRW", 0, 0, requestBytes.data(), uint32_t(requestBytes.size())) < 0) return 500;
    if (plugin_push_output_ex("earth_orientation", "PRW.fbs", "$PRW", PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, "PRW", 0, 0, eopBytes.data(), uint32_t(eopBytes.size())) < 0) return 500;
    if (plugin_push_output_ex("vcm", "VCM.fbs", "$VCM", PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, "VCM", 0, 0, vcmBytes.data(), uint32_t(vcmBytes.size())) < 0) return 500;
    if (plugin_push_output_ex("report", nullptr, nullptr, PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY, nullptr, 0, 1, reinterpret_cast<const uint8_t*>(r.data()), uint32_t(r.size())) < 0) return 500;
    return 0;
}

int write(void) {
    const int32_t resultIndex = plugin_find_input_index("result", 0);
    const plugin_input_frame_t* frame = resultIndex >= 0 ? plugin_get_input_frame(uint32_t(resultIndex)) : nullptr;
    if (!frame || !frame->payload || frame->payload_length < 8) {
        plugin_set_error("missing-result", "write requires a $PRW EXECUTION_RESULT on port \"result\".");
        return 400;
    }
    ::flatbuffers::Verifier verifier(frame->payload, frame->payload_length);
    if (!VerifySizePrefixedPRWBuffer(verifier)) { plugin_set_error("invalid-result", "Port \"result\" is not a size-prefixed $PRW FlatBuffer."); return 400; }
    const PRW* prw = GetSizePrefixedPRW(frame->payload);
    const PRWExecutionResult* result = prw->EXECUTION_RESULT();
    if (!result || !result->FINAL_SAMPLE() || !result->FINAL_SAMPLE()->STATE() || !result->FINAL_SAMPLE()->STATE()->STATE()) {
        plugin_set_error("invalid-result", "write requires EXECUTION_RESULT.FINAL_SAMPLE.STATE.");
        return 400;
    }
    const auto* sample = result->FINAL_SAMPLE();
    const auto* state = sample->STATE()->STATE();
    const auto* frameName = state->COORDINATE_SYSTEM_NAME();
    const std::string axes = frameName ? frameName->str() : "";
    if (axes != "EME2000" && axes != "J2000") {
        plugin_set_error("unsupported-frame", "write takes a result in EME2000 (request the propagation in EME2000, as read builds it).");
        return 400;
    }
    if (!state->POSITION() || !state->VELOCITY() || !state->EPOCH()) { plugin_set_error("invalid-result", "The final state needs position, velocity and epoch."); return 400; }
    // Header options.
    std::vector<std::pair<std::string, std::string>> h;
    {
        const int32_t headerIndex = plugin_find_input_index("header", 0);
        const plugin_input_frame_t* hf = headerIndex >= 0 ? plugin_get_input_frame(uint32_t(headerIndex)) : nullptr;
        std::string error;
        if (hf && hf->payload && hf->payload_length && !readFlatJson(std::string(reinterpret_cast<const char*>(hf->payload), hf->payload_length), h, error)) {
            plugin_set_error("invalid-header", error.c_str());
            return 400;
        }
    }
    auto text = [&](const char* key, const char* fallback) { const std::string* v = lookup(h, key); return v ? (v->size() && (*v)[0] == '"' ? v->substr(1) : *v) : std::string(fallback); };
    auto num = [&](const char* key, double fallback) { const std::string* v = lookup(h, key); double x = fallback; if (v) number(*v, &x); return x; };
    double nScale = 1000.0;
    bool fractionalMeanMotion = true;
    if (!meanMotionRow(text("meanMotionUnit", "fraction"), nScale, fractionalMeanMotion)) { plugin_set_error("invalid-header", "meanMotionUnit is fraction, rad/ks, rad/s, rad/min or rev/day"); return 400; }
    const std::string geopotential = text("geopotential", "EGM-96");
    const double mu = gmFor(geopotential);
    const double rv[6] = {state->POSITION()->X() / 1000, state->POSITION()->Y() / 1000, state->POSITION()->Z() / 1000,
                          state->VELOCITY()->X() / 1000, state->VELOCITY()->Y() / 1000, state->VELOCITY()->Z() / 1000};
    // Epoch: the result labels it TDB; the VCM wants UTC.
    std::string epochText = state->EPOCH()->str();
    const std::string scale = state->EPOCH_TIME_SYSTEM() ? state->EPOCH_TIME_SYSTEM()->str() : "UTC";
    int y = 0, mo = 0, d = 0, hh = 0, mi = 0;
    double ss = 0;
    if (std::sscanf(epochText.c_str(), "%d-%d-%dT%d:%d:%lf", &y, &mo, &d, &hh, &mi, &ss) != 6) { plugin_set_error("invalid-result", "Unreadable final epoch."); return 400; }
    double u1 = 0, u2 = 0;
    if (scale == "TDB" || scale == "TT") {
        double t1 = 0, t2 = 0;
        if (eraDtf2d("TT", y, mo, d, hh, mi, ss, &t1, &t2) != 0) { plugin_set_error("invalid-result", "Final epoch out of range."); return 400; }
        // TDB - TT is below 2 ms; the VCM prints milliseconds.
        double a1 = 0, a2 = 0;
        eraTttai(t1, t2, &a1, &a2);
        eraTaiutc(a1, a2, &u1, &u2);
    } else if (scale == "UTC") {
        eraDtf2d("UTC", y, mo, d, hh, mi, ss, &u1, &u2);
    } else { plugin_set_error("invalid-result", "Final epoch must be UTC, TT or TDB."); return 400; }
    int iy = 0, im = 0, id = 0, ihmsf[4] = {0, 0, 0, 0};
    eraD2dtf("UTC", 3, u1, u2, &iy, &im, &id, ihmsf);
    Utc epoch;
    epoch.year = iy; epoch.month = im; epoch.day = id; epoch.hour = ihmsf[0]; epoch.minute = ihmsf[1];
    epoch.second = ihmsf[2] + ihmsf[3] / 1000.0; epoch.ok = true;

    // ECI (TEME) and EFG: GCRF = B^T EME2000, TEME from the axis engine,
    // EFG = R3(GMST 1982 of UT1) TEME (polar motion not applied, as the VCM says).
    double rb[3][3], rp[3][3], rbp[3][3];
    double tt1 = 0, tt2 = 0;
    {
        double a1 = 0, a2 = 0;
        eraUtctai(u1, u2, &a1, &a2);
        eraTaitt(a1, a2, &tt1, &tt2);
    }
    eraBp06(tt1, tt2, rb, rp, rbp);
    double gcrf[6];
    for (int k = 0; k < 2; ++k)
        for (int i = 0; i < 3; ++i) gcrf[3 * k + i] = rb[0][i] * rv[3 * k] + rb[1][i] * rv[3 * k + 1] + rb[2][i] * rv[3 * k + 2];
    sdn::frames::Epoch e;
    e.tt1 = tt1; e.tt2 = tt2; e.ut11 = 0; e.ut12 = 0;
    const sdn::frames::Mat3 R = sdn::frames::gcrfToTeme(e);
    sdn::frames::Epoch e1 = e, e2 = e;
    e1.tt2 -= 600.0 / 86400.0; e2.tt2 += 600.0 / 86400.0;
    const sdn::frames::Mat3 Ra = sdn::frames::gcrfToTeme(e1), Rb = sdn::frames::gcrfToTeme(e2);
    double teme[6];
    for (int i = 0; i < 3; ++i) {
        teme[i] = R.m[i][0] * gcrf[0] + R.m[i][1] * gcrf[1] + R.m[i][2] * gcrf[2];
        double rate = 0;
        for (int j = 0; j < 3; ++j) rate += (Rb.m[i][j] - Ra.m[i][j]) / 1200.0 * gcrf[j];
        teme[3 + i] = R.m[i][0] * gcrf[3] + R.m[i][1] * gcrf[4] + R.m[i][2] * gcrf[5] + rate;
    }
    const double ut1Utc = num("ut1MinusUtcS", 0.0);
    const double gmst = eraGmst82(u1, u2 + ut1Utc / 86400.0);
    const double c = std::cos(gmst), s = std::sin(gmst);
    double efg[6] = {c * teme[0] + s * teme[1], -s * teme[0] + c * teme[1], teme[2], 0, 0, teme[5]};
    efg[3] = c * teme[3] + s * teme[4] + kEarthRate * efg[1];
    efg[4] = -s * teme[3] + c * teme[4] - kEarthRate * efg[0];

    // Covariance: Cartesian SI (6 + parameters) -> equinoctial with the VCM's
    // parameter slots (B, BDOT, AGOM, T), unscaled by the weighted RMS.
    const V3<double> hv = cross(V3<double>{rv[0], rv[1], rv[2]}, V3<double>{rv[3], rv[4], rv[5]});
    const int fr = hv.z >= 0 ? 1 : -1;
    std::vector<double> eqCov;
    unsigned size = 0;
    double sig[6] = {};
    const double rms = num("weightedRms", 1.0);
    if (const auto* cov = sample->COVARIANCE()) {
        const unsigned n = cov->DIMENSION();
        if (!cov->VALUES() || cov->VALUES()->size() != n * n || n < 6) { plugin_set_error("invalid-result", "Covariance dimension and values disagree."); return 400; }
        std::vector<double> p(n * n);
        for (unsigned i = 0; i < n; ++i) for (unsigned j = 0; j < n; ++j) p[i * n + j] = cov->VALUES()->Get(i * n + j) / ((i < 6 ? 1000.0 : 1.0) * (j < 6 ? 1000.0 : 1.0));
        // The result's covariance is the one the sigmas are printed from;
        // the message carries it divided by max(1, RMS)^2 (read's inverse).
        uvwSigmasOf(rv, p, n, sig);
        double tj[36];
        jacobianToEquinoctial(rv, mu, fr, nScale, tj);
        const std::vector<double> q = transform(p, n, tj);
        // Parameter slots.
        std::vector<int> slot(n, -1);
        for (unsigned i = 0; i < 6; ++i) slot[i] = int(i);
        size = 6;
        const auto* params = result->DYNAMIC_PARAMETERS();
        if ((params ? params->size() : 0u) != n - 6) { plugin_set_error("invalid-result", "DYNAMIC_PARAMETERS do not match the covariance dimension."); return 400; }
        for (unsigned k = 0; k < n - 6; ++k) {
            const auto kind = static_cast<prwDynamicParameter>(params->Get(k));
            const int at = kind == prwDynamicParameter::DRAG_AREA_OVER_MASS ? 6 : kind == prwDynamicParameter::DRAG_AREA_OVER_MASS_RATE ? 7
                         : kind == prwDynamicParameter::SRP_AREA_OVER_MASS ? 8 : kind == prwDynamicParameter::IN_TRACK_ACCELERATION ? 9 : -1;
            if (at < 0) { plugin_set_error("invalid-result", "Unknown dynamic parameter."); return 400; }
            slot[6 + k] = at;
            size = std::max(size, unsigned(at + 1));
        }
        eqCov.assign(size * size, 0.0);
        for (unsigned i = 0; i < n; ++i) for (unsigned j = 0; j < n; ++j) eqCov[slot[i] * size + slot[j]] = q[i * n + j];
        // Parameter rows back as fractions when asked (the read's option).
        const std::string rows = text("parameterRows", "fractional");
        if (rows != "absolute" && rows != "fractional") { plugin_set_error("invalid-header", "parameterRows is absolute or fractional"); return 400; }
        if (rows == "fractional") {
            const double b = num("ballisticCoefficient", 0.0), agom = num("agom", 0.0);
            std::vector<double> scaleOf(size, 1.0);
            if (size > 6) { if (!(b > 0)) { plugin_set_error("invalid-header", "fractional parameter rows need ballisticCoefficient > 0"); return 400; } scaleOf[6] = 1.0 / b; }
            if (size > 8 && agom > 0) scaleOf[8] = 1.0 / agom;
            for (unsigned i = 0; i < size; ++i) for (unsigned j = 0; j < size; ++j) eqCov[i * size + j] *= scaleOf[i] * scaleOf[j];
        }
        {
            double ew[6];
            cartesianToEquinoctial(rv, mu, fr, nScale, ew);
            const double unscale = 1.0 / (std::max(1.0, rms) * std::max(1.0, rms));
            for (unsigned i = 0; i < size; ++i) for (unsigned j = 0; j < size; ++j) {
                double f = unscale;
                if (fractionalMeanMotion && i == 3) f /= ew[3];
                if (fractionalMeanMotion && j == 3) f /= ew[3];
                eqCov[i * size + j] *= f;
            }
        }
    }

    char line[160];
    std::string out;
    auto put = [&](const std::string& s) { out += "<> " + s + "\n"; };
    Utc messageTime = epoch;
    if (const std::string* mt = lookup(h, "messageTime")) { Utc t = parseVcmTime(mt->size() && (*mt)[0] == '"' ? mt->substr(1) : *mt); if (t.ok) messageTime = t; }
    put("SP VECTOR/COVARIANCE MESSAGE - V2.0");
    put(text("indicator", ""));
    std::snprintf(line, sizeof line, "MESSAGE TIME (UTC): %s  CENTER: %s", vcmTime(messageTime).c_str(), text("center", "SDN").c_str()); put(line);
    std::snprintf(line, sizeof line, "SATELLITE NUMBER: %05ld                    INT. DES.: %s", std::lround(num("satelliteNumber", 0)), text("internationalDesignator", "").c_str()); put(line);
    put("COMMON NAME: " + text("commonName", ""));
    std::snprintf(line, sizeof line, "EPOCH TIME (UTC): %s  EPOCH REV: %5ld", vcmTime(epoch).c_str(), std::lround(num("epochRev", 0))); put(line);
    auto posLine = [&](const char* label, const double* v) { std::snprintf(line, sizeof line, "%-15s %16.8f %16.8f %16.8f", label, v[0], v[1], v[2]); put(line); };
    auto velLine = [&](const char* label, const double* v) { std::snprintf(line, sizeof line, "%-15s %16.12f %16.12f %16.12f", label, v[0], v[1], v[2]); put(line); };
    posLine("J2K POS (KM):", rv); velLine("J2K VEL (KM/S):", rv + 3);
    posLine("ECI POS (KM):", teme); velLine("ECI VEL (KM/S):", teme + 3);
    posLine("EFG POS (KM):", efg); velLine("EFG VEL (KM/S):", efg + 3);
    std::snprintf(line, sizeof line, "GEOPOTENTIAL: %s %2ldZ,%2ldT  DRAG: %12s  LUNAR/SOLAR: %3s", geopotential.c_str(), std::lround(num("zonals", 0)), std::lround(num("tesserals", 0)), text("drag", "NONE").c_str(), text("lunarSolar", "OFF").c_str()); put(line);
    std::snprintf(line, sizeof line, "SOLAR RAD PRESS: %3s  SOLID EARTH TIDES: %3s  IN-TRACK THRUST: %3s", text("solarRadiationPressure", "OFF").c_str(), text("solidEarthTides", "OFF").c_str(), text("inTrackThrust", "OFF").c_str()); put(line);
    std::snprintf(line, sizeof line, "BALLISTIC COEF (M2/KG): %13s BDOT (M2/KG-S): %12s", fortranE(num("ballisticCoefficient", 0), 6).c_str(), fortranE(num("bdot", 0), 6).c_str()); put(line);
    std::snprintf(line, sizeof line, "SOLAR RAD PRESS COEFF (M2/KG): %13s  EDR(W/KG): %9s", fortranE(num("agom", 0), 6).c_str(), fortranE(num("edr", 0), 2).c_str()); put(line);
    std::snprintf(line, sizeof line, "THRUST ACCEL (M/S2): %13s  C.M. OFFSET (M): %13s", fortranE(num("thrustAcceleration", 0), 6).c_str(), fortranE(num("centerOfMassOffset", 0), 6).c_str()); put(line);
    std::snprintf(line, sizeof line, "SOLAR FLUX: F10: %3ld  AVERAGE F10: %3ld  AVERAGE AP: %5.1f", std::lround(num("f10", 0)), std::lround(num("averageF10", 0)), num("averageAp", 0)); put(line);
    std::snprintf(line, sizeof line, "TAI-UTC (S): %2ld  UT1-UTC (S): %8.5f  UT1 RATE (MS/DAY): %6.3f", std::lround(num("taiMinusUtcS", 37)), ut1Utc, num("ut1RateMsPerDay", 0)); put(line);
    std::snprintf(line, sizeof line, "POLAR MOT X,Y (ARCSEC): %7.4f %7.4f IAU 1980 NUTAT: %3ld TERMS", num("polarX", 0), num("polarY", 0), std::lround(num("nutationTerms", 106))); put(line);
    put("TIME CONST LEAP SECOND TIME (UTC): " + text("leapSecondTime", "2049 365 (31 DEC) 23:59:59.999"));
    std::snprintf(line, sizeof line, "INTEGRATOR MODE: %-12s COORD SYS: %-5s  PARTIALS: %s", text("integratorMode", "SDN HPOP").c_str(), "J2000", text("partials", "ANALYTIC").c_str()); put(line);
    std::snprintf(line, sizeof line, "STEP MODE: %s  FIXED STEP: %s  STEP SIZE SELECTION: %s", text("stepMode", "AUTO").c_str(), text("fixedStep", "OFF").c_str(), text("stepSizeSelection", "AUTO").c_str()); put(line);
    std::snprintf(line, sizeof line, "INITIAL STEP SIZE (S): %8.3f  ERROR CONTROL: %9s", num("initialStepSize", 30), fortranE(num("errorControl", 1e-13), 3).c_str()); put(line);
    std::snprintf(line, sizeof line, "VECTOR U,V,W SIGMAS (KM):        %10.4f %10.4f %10.4f", sig[0], sig[1], sig[2]); put(line);
    std::snprintf(line, sizeof line, "VECTOR UD,VD,WD SIGMAS (KM/S):    %10.4f %10.4f %10.4f", sig[3], sig[4], sig[5]); put(line);
    std::snprintf(line, sizeof line, "COVARIANCE MATRIX (EQUINOCTIAL ELS): (%2ux%2u) WTD RMS: %12s", size, size, fortranE(rms, 5).c_str()); put(line);
    std::string row;
    int count = 0;
    for (unsigned i = 0; i < size; ++i)
        for (unsigned j = 0; j <= i; ++j) {
            std::snprintf(line, sizeof line, "%s%12s", row.empty() ? "" : " ", fortranE(eqCov[i * size + j], 5).c_str());
            row += line;
            if (++count % 5 == 0) { put(row); row.clear(); }
        }
    if (!row.empty()) put(row);
    if (plugin_push_output_ex("message", nullptr, nullptr, PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY, nullptr, 0, 1, reinterpret_cast<const uint8_t*>(out.data()), uint32_t(out.size())) < 0) return 500;
    return 0;
}

}  // extern "C"
