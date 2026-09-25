// C++ port of hwm14.f90 (NRL HWM14.123114). Routine and variable names follow
// the FORTRAN so the two can be read side by side; comments name the FORTRAN
// line being reproduced where the port has to be careful about precision.
#include "hwm14.hpp"

#include <cmath>
#include <cstring>
#include <stdexcept>
#include <string>

// Exact parity needs every multiply and add rounded separately.
#pragma STDC FP_CONTRACT OFF
#if defined(__clang__)
#pragma clang fp contract(off)
#elif defined(__GNUC__)
#pragma GCC optimize("fp-contract=off")
#endif

namespace hwm14 {

namespace {

// FORTRAN evaluates sin and cos of the same argument as two separate libm
// calls. Optimising compilers fuse such pairs into sincos, which can differ in
// the last bit, so every sin/cos goes through these non-inlined wrappers.
[[gnu::noinline]] double hsin(double x) { return std::sin(x); }
[[gnu::noinline]] double hcos(double x) { return std::cos(x); }
[[gnu::noinline]] float hsin(float x) { return std::sin(x); }
[[gnu::noinline]] float hcos(float x) { return std::cos(x); }

// ---------------------------------------------------------------- SHA-256
// Small self-contained implementation used only to verify the embedded data.
std::string sha256Hex(const unsigned char* data, std::size_t size) {
    static const uint32_t k[64] = {
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
        0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
        0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
        0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
        0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2};
    uint32_t h[8] = {0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
                     0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19};
    auto rotr = [](uint32_t x, int n) { return (x >> n) | (x << (32 - n)); };
    std::vector<unsigned char> msg(data, data + size);
    const uint64_t bits = static_cast<uint64_t>(size) * 8u;
    msg.push_back(0x80);
    while (msg.size() % 64 != 56) msg.push_back(0);
    for (int i = 7; i >= 0; --i) msg.push_back(static_cast<unsigned char>(bits >> (8 * i)));
    for (std::size_t off = 0; off < msg.size(); off += 64) {
        uint32_t w[64];
        for (int i = 0; i < 16; ++i) {
            w[i] = (uint32_t(msg[off + 4 * i]) << 24) | (uint32_t(msg[off + 4 * i + 1]) << 16) |
                   (uint32_t(msg[off + 4 * i + 2]) << 8) | uint32_t(msg[off + 4 * i + 3]);
        }
        for (int i = 16; i < 64; ++i) {
            const uint32_t s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >> 3);
            const uint32_t s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16] + s0 + w[i - 7] + s1;
        }
        uint32_t a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
        for (int i = 0; i < 64; ++i) {
            const uint32_t s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
            const uint32_t ch = (e & f) ^ (~e & g);
            const uint32_t t1 = hh + s1 + ch + k[i] + w[i];
            const uint32_t s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
            const uint32_t mj = (a & b) ^ (a & c) ^ (b & c);
            const uint32_t t2 = s0 + mj;
            hh = g; g = f; f = e; e = d + t1; d = c; c = b; b = a; a = t1 + t2;
        }
        h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
    }
    static const char* hex = "0123456789abcdef";
    std::string out;
    for (uint32_t v : h) {
        for (int i = 7; i >= 0; --i) out.push_back(hex[(v >> (4 * i)) & 0xf]);
    }
    return out;
}

const EmbeddedFile& embedded(const char* name) {
    std::size_t count = 0;
    const EmbeddedFile* files = embeddedFiles(&count);
    for (std::size_t i = 0; i < count; ++i) {
        if (std::strcmp(files[i].name, name) == 0) return files[i];
    }
    throw std::runtime_error(std::string("hwm14: missing embedded data file ") + name);
}

// Little-endian readers for FORTRAN stream and sequential files.
class Reader {
public:
    Reader(const unsigned char* data, std::size_t size) : p_(data), end_(data + size) {}
    int32_t i32() { int32_t v; take(&v, 4); return v; }
    float f32() { float v; take(&v, 4); return v; }
    double f64() { double v; take(&v, 8); return v; }
    // FORTRAN unformatted sequential record: 4-byte length, payload, 4-byte length.
    Reader record() {
        const int32_t n = i32();
        if (n < 0 || static_cast<std::size_t>(end_ - p_) < static_cast<std::size_t>(n) + 4u) {
            throw std::runtime_error("hwm14: truncated record");
        }
        Reader r(p_, static_cast<std::size_t>(n));
        p_ += n;
        if (i32() != n) throw std::runtime_error("hwm14: record markers disagree");
        return r;
    }
    bool atEnd() const { return p_ == end_; }

private:
    void take(void* out, std::size_t n) {
        if (static_cast<std::size_t>(end_ - p_) < n) throw std::runtime_error("hwm14: truncated data");
        std::memcpy(out, p_, n);
        p_ += n;
    }
    const unsigned char* p_;
    const unsigned char* end_;
};

// FORTRAN parameters.
constexpr double kTwoPi = 2.0 * 3.1415926535897932384626433832795;  // hwmqt twoPi
constexpr double kDeg2Rad = kTwoPi / 360.0;                          // hwmqt deg2rad
constexpr double kQwmH = 60.0;                                        // qwm H
// module dwm: "real(8), parameter :: pi=3.1415926535897932" has no kind suffix,
// so the literal is single precision before promotion.
constexpr double kDwmPi = static_cast<double>(3.1415926535897932f);
constexpr double kDwmDtor = kDwmPi / 180.0;
// module gd2qdc: pi = 3.1415926535897932d0.
constexpr double kQdPi = 3.1415926535897932;
constexpr double kQdDtor = kQdPi / 180.0;
constexpr double kSinEps = 0.39781868;
constexpr float kDwmTalt = 125.0f;  // dwm07 talt

}  // namespace

// ---------------------------------------------------------------- ALF basis
AlfCoefficients::AlfCoefficients(int nmaxIn, int mmaxIn) : nmax(nmaxIn), mmax(mmaxIn) {
    const int rows = nmax + 1;
    anm.assign(static_cast<std::size_t>(rows) * (mmax + 1), 0.0);
    bnm = anm;
    dnm = anm;
    cm.assign(mmax + 1, 0.0);
    en.assign(nmax + 1, 0.0);
    marr.assign(mmax + 1, 0.0);
    narr.assign(nmax + 1, 0.0);
    auto at = [rows](std::vector<double>& a, int64_t n, int64_t m) -> double& {
        return a[static_cast<std::size_t>(n + m * rows)];
    };
    // initalf: integer(8) products, dble() of each, left to right.
    for (int64_t n = 1; n <= nmax; ++n) {
        narr[n] = static_cast<double>(n);
        en[n] = std::sqrt(static_cast<double>(n * (n + 1)));
        at(anm, n, 0) = std::sqrt(static_cast<double>((2 * n - 1) * (2 * n + 1))) / narr[n];
        at(bnm, n, 0) = std::sqrt(static_cast<double>((2 * n + 1) * (n - 1) * (n - 1)) /
                                  static_cast<double>(2 * n - 3)) / narr[n];
    }
    for (int64_t m = 1; m <= mmax; ++m) {
        marr[m] = static_cast<double>(m);
        cm[m] = std::sqrt(static_cast<double>(2 * m + 1) / static_cast<double>(2 * m * m * (m + 1)));
        for (int64_t n = m + 1; n <= nmax; ++n) {
            at(anm, n, m) = std::sqrt(static_cast<double>((2 * n - 1) * (2 * n + 1) * (n - 1)) /
                                      static_cast<double>((n - m) * (n + m) * (n + 1)));
            at(bnm, n, m) = std::sqrt(static_cast<double>((2 * n + 1) * (n + m - 1) * (n - m - 1) * (n - 2) * (n - 1)) /
                                      static_cast<double>((n - m) * (n + m) * (2 * n - 3) * n * (n + 1)));
            at(dnm, n, m) = std::sqrt(static_cast<double>((n - m) * (n + m) * (2 * n + 1) * (n - 1)) /
                                      static_cast<double>((2 * n - 1) * (n + 1)));
        }
    }
}

void alfbasis(const AlfCoefficients& c, int nmax, int mmax, double theta, double* P, double* V,
              double* W, int ld) {
    const int crow = c.nmax + 1;
    auto A = [&](int64_t n, int64_t m) { return c.anm[static_cast<std::size_t>(n + m * crow)]; };
    auto B = [&](int64_t n, int64_t m) { return c.bnm[static_cast<std::size_t>(n + m * crow)]; };
    auto D = [&](int64_t n, int64_t m) { return c.dnm[static_cast<std::size_t>(n + m * crow)]; };
    auto p = [&](int64_t n, int64_t m) -> double& { return P[n + m * ld]; };
    auto v = [&](int64_t n, int64_t m) -> double& { return V[n + m * ld]; };
    auto w = [&](int64_t n, int64_t m) -> double& { return W[n + m * ld]; };
    const double p00 = 0.70710678118654746;
    p(0, 0) = p00;
    const double x = hcos(theta);
    const double y = hsin(theta);
    for (int64_t m = 1; m <= mmax; ++m) {
        w(m, m) = c.cm[m] * p(m - 1, m - 1);
        p(m, m) = y * c.en[m] * w(m, m);
        for (int64_t n = m + 1; n <= nmax; ++n) {
            w(n, m) = A(n, m) * x * w(n - 1, m) - B(n, m) * w(n - 2, m);
            p(n, m) = y * c.en[n] * w(n, m);
            v(n, m) = c.narr[n] * x * w(n, m) - D(n, m) * w(n - 1, m);
            w(n - 2, m) = c.marr[m] * w(n - 2, m);
        }
        w(nmax - 1, m) = c.marr[m] * w(nmax - 1, m);
        w(nmax, m) = c.marr[m] * w(nmax, m);
        v(m, m) = x * w(m, m);
    }
    p(1, 0) = A(1, 0) * x * p(0, 0);
    v(1, 0) = -p(1, 1);
    for (int64_t n = 2; n <= nmax; ++n) {
        p(n, 0) = A(n, 0) * x * p(n - 1, 0) - B(n, 0) * p(n - 2, 0);
        v(n, 0) = -p(n, 1);
    }
}

// ---------------------------------------------------------------- model data
struct ModelData {
    // qwm
    int nbf = 0, maxs = 0, maxm = 0, maxl = 0, maxn = 0, ncomp = 0;
    int nlev = 0, p = 0, nnode = 0;
    double alttns = 0, altsym = 0, altiso = 0;
    double e1[5] = {}, e2[5] = {};
    std::vector<int> nb;          // nb(0:nnode)
    std::vector<int> order;       // order(1:ncomp, 0:nnode), column-major
    std::vector<double> vnode;    // vnode(0:nnode)
    std::vector<double> mparm;    // mparm(1:nbf, 0:nlev)
    std::vector<double> tparm;    // tparm(1:nbf, 0:nlev)
    // dwm
    int dwmNterm = 0, dwmNmax = 0, dwmMmax = 0, nvshterm = 0;
    std::vector<int> termarr;     // termarr(0:2, 0:nterm-1)
    std::vector<float> coeff;     // coeff(0:nterm-1)
    float twidth = 0;
    // gd2qdc
    int qdNmax = 0, qdMmax = 0, qdNterm = 0;
    float qdEpoch = 0, qdAlt = 0;
    std::vector<double> xcoeff, ycoeff, zcoeff, normadj;
    // module hwm: sizes of the shared geo basis arrays (inithwm)
    int nmaxgeo = 0, mmaxgeo = 0;
    AlfCoefficients alf{0, 0};

    int orderAt(int k, int level) const { return order[static_cast<std::size_t>((k - 1) + level * ncomp)]; }
    const double* mparmLevel(int level) const { return &mparm[static_cast<std::size_t>(level) * nbf]; }
    const double* tparmLevel(int level) const { return &tparm[static_cast<std::size_t>(level) * nbf]; }
};

namespace {

void verify(const EmbeddedFile& f) {
    if (sha256Hex(f.bytes, f.size) != f.sha256) {
        throw std::runtime_error(std::string("hwm14: SHA-256 mismatch for ") + f.name);
    }
}

// initqwm's parity(): fills tparm and zeroes parts of mparm, in place.
void parity(const int order[8], double* mparm, double* tparm) {
    const int amaxs = order[0], amaxn = order[1], pmaxm = order[2], pmaxs = order[3];
    const int pmaxn = order[4], tmaxl = order[5], tmaxs = order[6], tmaxn = order[7];
    auto mp = [&](int i) -> double& { return mparm[i - 1]; };
    auto tp = [&](int i) -> double& { return tparm[i - 1]; };
    int c = 1;
    for (int n = 1; n <= amaxn; ++n) {
        tp(c) = 0.0;
        tp(c + 1) = -mp(c + 1);
        mp(c + 1) = 0.0;
        c += 2;
    }
    for (int s = 1; s <= amaxs; ++s) {
        for (int n = 1; n <= amaxn; ++n) {
            tp(c) = 0.0;
            tp(c + 1) = 0.0;
            tp(c + 2) = -mp(c + 2);
            tp(c + 3) = -mp(c + 3);
            mp(c + 2) = 0.0;
            mp(c + 3) = 0.0;
            c += 4;
        }
    }
    auto block = [&](int lo, int hi, int smax) {
        for (int n = lo; n <= hi; ++n) {
            tp(c) = mp(c + 2);
            tp(c + 1) = mp(c + 3);
            tp(c + 2) = -mp(c);
            tp(c + 3) = -mp(c + 1);
            c += 4;
        }
        for (int s = 1; s <= smax; ++s) {
            for (int n = lo; n <= hi; ++n) {
                tp(c) = mp(c + 2);
                tp(c + 1) = mp(c + 3);
                tp(c + 2) = -mp(c);
                tp(c + 3) = -mp(c + 1);
                tp(c + 4) = mp(c + 6);
                tp(c + 5) = mp(c + 7);
                tp(c + 6) = -mp(c + 4);
                tp(c + 7) = -mp(c + 5);
                c += 8;
            }
        }
    };
    for (int m = 1; m <= pmaxm; ++m) block(m, pmaxn, pmaxs);
    for (int l = 1; l <= tmaxl; ++l) block(l, tmaxn, tmaxs);
}

void loadQwm(ModelData& d) {
    const EmbeddedFile& f = embedded("hwm123114.bin");
    verify(f);
    Reader r(f.bytes, f.size);  // access='stream': no record markers
    d.nbf = r.i32(); d.maxs = r.i32(); d.maxm = r.i32(); d.maxl = r.i32(); d.maxn = r.i32(); d.ncomp = r.i32();
    d.nlev = r.i32(); d.p = r.i32();
    d.nnode = d.nlev + d.p;
    d.nb.assign(d.nnode + 1, 0);
    d.order.assign(static_cast<std::size_t>(d.ncomp) * (d.nnode + 1), 0);
    d.vnode.assign(d.nnode + 1, 0.0);
    for (int i = 0; i <= d.nnode; ++i) d.vnode[i] = r.f64();
    d.vnode[3] = 0.0;  // "vnode(3) = 0.0"
    d.mparm.assign(static_cast<std::size_t>(d.nbf) * (d.nlev + 1), 0.0);
    d.tparm.assign(static_cast<std::size_t>(d.nbf) * (d.nlev + 1), 0.0);
    const int lastLevel = d.nlev - d.p + 1 - 2;
    for (int i = 0; i <= lastLevel; ++i) {
        for (int k = 0; k < d.ncomp; ++k) d.order[static_cast<std::size_t>(k + i * d.ncomp)] = r.i32();
        d.nb[i] = r.i32();
        double* level = &d.mparm[static_cast<std::size_t>(i) * d.nbf];
        for (int k = 0; k < d.nbf; ++k) level[k] = r.f64();
    }
    for (double& v : d.e1) v = r.f64();
    for (double& v : d.e2) v = r.f64();
    if (!r.atEnd()) throw std::runtime_error("hwm14: unexpected trailing QWM data");
    for (int i = 0; i <= lastLevel; ++i) {
        parity(&d.order[static_cast<std::size_t>(i) * d.ncomp], &d.mparm[static_cast<std::size_t>(i) * d.nbf],
               &d.tparm[static_cast<std::size_t>(i) * d.nbf]);
    }
    d.alttns = d.vnode[d.nlev - 2];
    d.altsym = d.vnode[d.nlev - 1];
    d.altiso = d.vnode[d.nlev];
}

void loadDwm(ModelData& d) {
    const EmbeddedFile& f = embedded("dwm07b104i.dat");
    verify(f);
    Reader file(f.bytes, f.size);  // form='unformatted' sequential records
    Reader h = file.record();
    d.dwmNterm = h.i32(); d.dwmMmax = h.i32(); d.dwmNmax = h.i32();
    Reader t = file.record();
    d.termarr.resize(static_cast<std::size_t>(3) * d.dwmNterm);
    for (int& v : d.termarr) v = t.i32();
    Reader c = file.record();
    d.coeff.resize(d.dwmNterm);
    for (float& v : d.coeff) v = c.f32();
    Reader w = file.record();
    d.twidth = w.f32();
    if (!file.atEnd()) throw std::runtime_error("hwm14: unexpected trailing DWM data");
    const int nmax = d.dwmNmax, mmax = d.dwmMmax;
    d.nvshterm = (((nmax + 1) * (nmax + 2) - (nmax - mmax) * (nmax - mmax + 1)) / 2 - 1) * 4 - 2 * nmax;
}

void loadQd(ModelData& d) {
    const EmbeddedFile& f = embedded("gd2qd.dat");
    verify(f);
    Reader file(f.bytes, f.size);
    Reader h = file.record();
    d.qdNmax = h.i32(); d.qdMmax = h.i32(); d.qdNterm = h.i32(); d.qdEpoch = h.f32(); d.qdAlt = h.f32();
    Reader c = file.record();
    // coeff(0:nterm-1, 0:2), column-major.
    d.xcoeff.resize(d.qdNterm);
    d.ycoeff.resize(d.qdNterm);
    d.zcoeff.resize(d.qdNterm);
    for (double& v : d.xcoeff) v = c.f64();
    for (double& v : d.ycoeff) v = c.f64();
    for (double& v : d.zcoeff) v = c.f64();
    if (!file.atEnd()) throw std::runtime_error("hwm14: unexpected trailing QD data");
    d.normadj.resize(d.qdNmax + 1);
    for (int n = 0; n <= d.qdNmax; ++n) d.normadj[n] = std::sqrt(static_cast<double>(n * (n + 1)));
}

// vertwght's knot-span search. FORTRAN never terminates for u < V(p); the port
// returns p there, which changes nothing FORTRAN can return.
int findspan(int n, int p, double u, const double* V) {
    if (u >= V[n + 1]) return n;
    if (u < V[p]) return p;
    int low = p, high = n + 1, mid = (low + high) / 2;
    while (u < V[mid] || u >= V[mid + 1]) {
        if (u < V[mid]) high = mid; else low = mid;
        mid = (low + high) / 2;
    }
    return mid;
}

double bspline(int p, int m, const double* V, int i, double u) {
    if (i == 0 && u == V[0]) return 1.0;
    if (i == m - p - 1 && u == V[m]) return 1.0;
    if (u < V[i] || u >= V[i + p + 1]) return 0.0;
    double N[8] = {0};
    for (int j = 0; j <= p; ++j) N[j] = (u >= V[i + j] && u < V[i + j + 1]) ? 1.0 : 0.0;
    for (int k = 1; k <= p; ++k) {
        double saved = (N[0] == 0.0) ? 0.0 : ((u - V[i]) * N[0]) / (V[i + k] - V[i]);
        for (int j = 0; j <= p - k; ++j) {
            const double Vleft = V[i + j + 1];
            const double Vright = V[i + j + k + 1];
            if (N[j + 1] == 0.0) {
                N[j] = saved;
                saved = 0.0;
            } else {
                const double temp = N[j + 1] / (Vright - Vleft);
                N[j] = saved + (Vright - u) * temp;
                saved = (u - Vleft) * temp;
            }
        }
    }
    return N[0];
}

void vertwght(const ModelData& d, double alt, double wght[4], int* iz) {
    *iz = findspan(d.nnode - d.p - 1, d.p, alt, d.vnode.data()) - d.p;
    *iz = std::min(*iz, 26);
    const int m = d.nnode;
    wght[0] = bspline(d.p, m, d.vnode.data(), *iz, alt);
    wght[1] = bspline(d.p, m, d.vnode.data(), *iz + 1, alt);
    if (*iz <= 25) {
        wght[2] = bspline(d.p, m, d.vnode.data(), *iz + 2, alt);
        wght[3] = bspline(d.p, m, d.vnode.data(), *iz + 3, alt);
        return;
    }
    double we[5];
    if (alt > d.alttns) {
        we[0] = 0.0; we[1] = 0.0; we[2] = 0.0;
        we[3] = std::exp(-(alt - d.alttns) / kQwmH);
        we[4] = 1.0;
    } else {
        we[0] = bspline(d.p, m, d.vnode.data(), *iz + 2, alt);
        we[1] = bspline(d.p, m, d.vnode.data(), *iz + 3, alt);
        we[2] = bspline(d.p, m, d.vnode.data(), *iz + 4, alt);
        we[3] = 0.0; we[4] = 0.0;
    }
    double s3 = 0.0, s4 = 0.0;
    for (int k = 0; k < 5; ++k) s3 = s3 + we[k] * d.e1[k];
    for (int k = 0; k < 5; ++k) s4 = s4 + we[k] * d.e2[k];
    wght[2] = s3;
    wght[3] = s4;
}

double dot(const double* a, const double* b, int n) {
    double s = 0.0;
    for (int i = 0; i < n; ++i) s = s + a[i] * b[i];
    return s;
}

float dotf(const float* a, const float* b, int n, int strideB) {
    float s = 0.0f;
    for (int i = 0; i < n; ++i) s = s + a[i] * b[static_cast<std::size_t>(i) * strideB];
    return s;
}

}  // namespace

Model::Model() : d_(new ModelData) {
    try {
        loadQwm(*d_);
        loadDwm(*d_);
        loadQd(*d_);
        // inithwm: the geo basis arrays are sized before gd2qd is initialised,
        // so nmaxqdc/mmaxqdc are still 0 there.
        d_->nmaxgeo = std::max(d_->maxn, 0);
        d_->mmaxgeo = std::max(std::max(std::max(d_->maxs, d_->maxm), d_->maxl), 0);
        const int nmax0 = std::max(d_->nmaxgeo, d_->dwmNmax);
        const int mmax0 = std::max(d_->mmaxgeo, d_->dwmMmax);
        d_->alf = AlfCoefficients(nmax0, mmax0);
        // gd2qd and mltcalc write with the QD degree into arrays shaped
        // (0:nmaxgeo, 0:mmaxgeo); the release data make those shapes equal.
        if (d_->qdNmax != d_->nmaxgeo || d_->qdMmax != d_->mmaxgeo) {
            throw std::runtime_error("hwm14: QD and QWM basis sizes differ; port assumes the release data");
        }
    } catch (...) {
        delete d_;
        throw;
    }
}

Model::~Model() { delete d_; }

float Model::dwmTransitionWidth() const { return d_->twidth; }

void Model::hwm14(int iyd, float sec, float alt, float glat, float glon, float stl, float f107a,
                  float f107, const float ap[2], float w[2]) const {
    hwmqt(iyd, sec, alt, glat, glon, stl, f107a, f107, ap, w);
    if (ap[1] >= 0.0f) {
        float dw[2];
        dwm07(iyd, sec, alt, glat, glon, ap, dw);
        w[0] = w[0] + dw[0];
        w[1] = w[1] + dw[1];
    }
}

void Model::hwmqt(int iyd, float sec, float alt, float glat, float glon, float /*stl*/,
                  float /*f107a*/, float /*f107*/, const float* /*ap*/, float w[2]) const {
    const ModelData& d = *d_;
    const double input1 = static_cast<double>(iyd % 1000);
    const double input2 = static_cast<double>(sec);
    const double input3 = static_cast<double>(glon);
    const double input4 = static_cast<double>(glat);
    const double input5 = static_cast<double>(alt);

    // Seasonal variations.
    std::vector<double> fs1(d.maxs + 1), fs2(d.maxs + 1);
    {
        const double AA = input1 * kTwoPi / 365.25;
        for (int s = 0; s <= d.maxs; ++s) {
            const double BB = static_cast<double>(s) * AA;
            fs1[s] = hcos(BB);
            fs2[s] = hsin(BB);
        }
    }
    // Hourly changes, tidal variations.
    std::vector<double> fl1(d.maxl + 1), fl2(d.maxl + 1);
    {
        const double AA = std::fmod(input2 / 3600.0 + input3 / 15.0 + 48.0, 24.0);
        const double BB = AA * kTwoPi / 24.0;
        for (int l = 0; l <= d.maxl; ++l) {
            const double CC = static_cast<double>(l) * BB;
            fl1[l] = hcos(CC);
            fl2[l] = hsin(CC);
        }
    }
    // Longitude, stationary planetary waves.
    std::vector<double> fm1(d.maxm + 1), fm2(d.maxm + 1);
    {
        const double AA = input3 * kDeg2Rad;
        for (int m = 0; m <= d.maxm; ++m) {
            const double BB = static_cast<double>(m) * AA;
            fm1[m] = hcos(BB);
            fm2[m] = hsin(BB);
        }
    }
    // Latitude.
    const double theta = (90.0 - input4) * kDeg2Rad;
    const int ld = d.nmaxgeo + 1;
    std::vector<double> gp(static_cast<std::size_t>(ld) * (d.mmaxgeo + 1), 0.0);
    std::vector<double> gv = gp, gw = gp;
    alfbasis(d.alf, d.maxn, d.maxm, (90.0 - input4) * kDeg2Rad, gp.data(), gv.data(), gw.data(), ld);
    auto gvbar = [&](int n, int m) { return gv[static_cast<std::size_t>(n + m * ld)]; };
    auto gwbar = [&](int n, int m) { return gw[static_cast<std::size_t>(n + m * ld)]; };
    // Altitude.
    double zwght[4];
    int lev = 0;
    vertwght(d, input5, zwght, &lev);

    double u = 0.0, v = 0.0;
    std::vector<double> bz(d.nbf + 8, 0.0);
    for (int b = 0; b <= d.p; ++b) {
        if (zwght[b] == 0.0) continue;
        const int dd = b + lev;
        const int amaxs = d.orderAt(1, dd), amaxn = d.orderAt(2, dd);
        const int pmaxm = d.orderAt(3, dd), pmaxs = d.orderAt(4, dd), pmaxn = d.orderAt(5, dd);
        const int tmaxl = d.orderAt(6, dd), tmaxs = d.orderAt(7, dd), tmaxn = d.orderAt(8, dd);
        auto B = [&](int i) -> double& { return bz[static_cast<std::size_t>(i - 1)]; };
        int c = 1;
        // Seasonal, zonal average (m = 0).
        for (int n = 1; n <= amaxn; ++n) {
            B(c) = -hsin(n * theta);
            B(c + 1) = hsin(n * theta);
            c += 2;
        }
        for (int s = 1; s <= amaxs; ++s) {
            const double cs = fs1[s], ss = fs2[s];
            for (int n = 1; n <= amaxn; ++n) {
                const double sc = hsin(n * theta);
                B(c) = -sc * cs;
                B(c + 1) = sc * ss;
                B(c + 2) = sc * cs;
                B(c + 3) = -sc * ss;
                c += 4;
            }
        }
        // Stationary planetary waves (wavefactor = 1).
        for (int m = 1; m <= pmaxm; ++m) {
            const double cm = fm1[m] * 1.0, sm = fm2[m] * 1.0;
            for (int n = m; n <= pmaxn; ++n) {
                const double vb = gvbar(n, m), wb = gwbar(n, m);
                B(c) = -vb * cm;
                B(c + 1) = vb * sm;
                B(c + 2) = -wb * sm;
                B(c + 3) = -wb * cm;
                c += 4;
            }
            for (int s = 1; s <= pmaxs; ++s) {
                const double cs = fs1[s], ss = fs2[s];
                for (int n = m; n <= pmaxn; ++n) {
                    const double vb = gvbar(n, m), wb = gwbar(n, m);
                    B(c) = -vb * cm * cs;
                    B(c + 1) = vb * sm * cs;
                    B(c + 2) = -wb * sm * cs;
                    B(c + 3) = -wb * cm * cs;
                    B(c + 4) = -vb * cm * ss;
                    B(c + 5) = vb * sm * ss;
                    B(c + 6) = -wb * sm * ss;
                    B(c + 7) = -wb * cm * ss;
                    c += 8;
                }
            }
        }
        // Migrating solar tides (tidefactor = 1).
        for (int l = 1; l <= tmaxl; ++l) {
            const double cl = fl1[l] * 1.0, sl = fl2[l] * 1.0;
            for (int n = l; n <= tmaxn; ++n) {
                const double vb = gvbar(n, l), wb = gwbar(n, l);
                B(c) = -vb * cl;
                B(c + 1) = vb * sl;
                B(c + 2) = -wb * sl;
                B(c + 3) = -wb * cl;
                c += 4;
            }
            for (int s = 1; s <= tmaxs; ++s) {
                const double cs = fs1[s], ss = fs2[s];
                for (int n = l; n <= tmaxn; ++n) {
                    const double vb = gvbar(n, l), wb = gwbar(n, l);
                    B(c) = -vb * cl * cs;
                    B(c + 1) = vb * sl * cs;
                    B(c + 2) = -wb * sl * cs;
                    B(c + 3) = -wb * cl * cs;
                    B(c + 4) = -vb * cl * ss;
                    B(c + 5) = vb * sl * ss;
                    B(c + 6) = -wb * sl * ss;
                    B(c + 7) = -wb * cl * ss;
                    c += 8;
                }
            }
        }
        c = c - 1;
        u = u + zwght[b] * dot(bz.data(), d.mparmLevel(dd), c);
        v = v + zwght[b] * dot(bz.data(), d.tparmLevel(dd), c);
    }
    w[0] = static_cast<float>(v);
    w[1] = static_cast<float>(u);
}

void Model::gd2qd(float glatin, float glon, float* qlat, float* qlon, float* f1e, float* f1n,
                  float* f2e, float* f2n) const {
    const ModelData& d = *d_;
    const double glat = static_cast<double>(glatin);
    const int ld = d.nmaxgeo + 1;
    std::vector<double> gp(static_cast<std::size_t>(ld) * (d.mmaxgeo + 1), 0.0);
    std::vector<double> gv = gp, gw = gp;
    alfbasis(d.alf, d.qdNmax, d.qdMmax, (90.0 - glat) * kQdDtor, gp.data(), gv.data(), gw.data(), ld);
    auto P = [&](int n, int m) { return gp[static_cast<std::size_t>(n + m * ld)]; };
    auto V = [&](int n, int m) { return gv[static_cast<std::size_t>(n + m * ld)]; };
    auto W = [&](int n, int m) { return gw[static_cast<std::size_t>(n + m * ld)]; };
    const double phi = static_cast<double>(glon) * kQdDtor;
    const int nt = d.qdNterm;
    std::vector<double> sh(nt), sgt(nt), sgp(nt);
    int i = 0;
    for (int n = 0; n <= d.qdNmax; ++n) {
        sh[i] = P(n, 0);
        sgt[i] = V(n, 0) * d.normadj[n];
        sgp[i] = 0;
        ++i;
    }
    for (int m = 1; m <= d.qdMmax; ++m) {
        const double mphi = static_cast<double>(m) * phi;
        const double cosmphi = hcos(mphi), sinmphi = hsin(mphi);
        for (int n = m; n <= d.qdNmax; ++n) {
            sh[i] = P(n, m) * cosmphi;
            sh[i + 1] = P(n, m) * sinmphi;
            sgt[i] = V(n, m) * d.normadj[n] * cosmphi;
            sgt[i + 1] = V(n, m) * d.normadj[n] * sinmphi;
            sgp[i] = -W(n, m) * d.normadj[n] * sinmphi;
            sgp[i + 1] = W(n, m) * d.normadj[n] * cosmphi;
            i += 2;
        }
    }
    const double x = dot(sh.data(), d.xcoeff.data(), nt);
    const double y = dot(sh.data(), d.ycoeff.data(), nt);
    const double z = dot(sh.data(), d.zcoeff.data(), nt);
    const double qlonrad = std::atan2(y, x);
    const double cosqlon = hcos(qlonrad), sinqlon = hsin(qlonrad);
    const double cosqlat = x * cosqlon + y * sinqlon;
    *qlat = static_cast<float>(std::atan2(z, cosqlat) / kQdDtor);
    *qlon = static_cast<float>(qlonrad / kQdDtor);
    const double xgt = dot(sgt.data(), d.xcoeff.data(), nt);
    const double ygt = dot(sgt.data(), d.ycoeff.data(), nt);
    const double zgt = dot(sgt.data(), d.zcoeff.data(), nt);
    const double xgp = dot(sgp.data(), d.xcoeff.data(), nt);
    const double ygp = dot(sgp.data(), d.ycoeff.data(), nt);
    const double zgp = dot(sgp.data(), d.zcoeff.data(), nt);
    *f1e = static_cast<float>(-zgt * cosqlat + (xgt * cosqlon + ygt * sinqlon) * z);
    *f1n = static_cast<float>(-zgp * cosqlat + (xgp * cosqlon + ygp * sinqlon) * z);
    *f2e = static_cast<float>(ygt * cosqlon - xgt * sinqlon);
    *f2n = static_cast<float>(ygp * cosqlon - xgp * sinqlon);
}

float Model::mltcalc(float qlat, float qlon, float day, float ut) const {
    (void)qlat;
    const ModelData& d = *d_;
    const double asunglat =
        -std::asin(hsin((static_cast<double>(day) + static_cast<double>(ut) / 24.0 - 80.0) * kQdDtor) * kSinEps) /
        kQdDtor;
    const double asunglon = -(static_cast<double>(ut) * 15.0);
    const double theta = (90.0 - asunglat) * kQdDtor;
    const int ld = d.nmaxgeo + 1;
    std::vector<double> sp(static_cast<std::size_t>(ld) * (d.mmaxgeo + 1), 0.0);
    std::vector<double> sv = sp, sw = sp;
    alfbasis(d.alf, d.qdNmax, d.qdMmax, theta, sp.data(), sv.data(), sw.data(), ld);
    auto P = [&](int n, int m) { return sp[static_cast<std::size_t>(n + m * ld)]; };
    const double phi = asunglon * kQdDtor;
    std::vector<double> sh(d.qdNterm);
    int i = 0;
    for (int n = 0; n <= d.qdNmax; ++n) sh[i++] = P(n, 0);
    for (int m = 1; m <= d.qdMmax; ++m) {
        const double mphi = static_cast<double>(m) * phi;
        const double cosmphi = hcos(mphi), sinmphi = hsin(mphi);
        for (int n = m; n <= d.qdNmax; ++n) {
            sh[i] = P(n, m) * cosmphi;
            sh[i + 1] = P(n, m) * sinmphi;
            i += 2;
        }
    }
    const double x = dot(sh.data(), d.xcoeff.data(), d.qdNterm);
    const double y = dot(sh.data(), d.ycoeff.data(), d.qdNterm);
    // "asunqlon = sngl(datan2(y,x) / dtor)" into a real(8) variable.
    const double asunqlon = static_cast<double>(static_cast<float>(std::atan2(y, x) / kQdDtor));
    return static_cast<float>((static_cast<double>(qlon) - asunqlon) / static_cast<double>(15.0f));
}

float Model::ap2kp(float ap0) {
    static const float apgrid[28] = {0.f, 2.f, 3.f, 4.f, 5.f, 6.f, 7.f, 9.f, 12.f, 15.f, 18.f, 22.f, 27.f, 32.f,
                                     39.f, 48.f, 56.f, 67.f, 80.f, 94.f, 111.f, 132.f, 154.f, 179.f, 207.f, 236.f,
                                     300.f, 400.f};
    float ap = ap0;
    if (ap < 0) ap = 0;
    if (ap > 400) ap = 400;
    auto kpgrid = [](int i) { return static_cast<float>(i) / 3.0f; };
    int i = 1;
    while (ap > apgrid[i]) ++i;
    if (ap == apgrid[i]) return kpgrid(i);
    return kpgrid(i - 1) + (ap - apgrid[i - 1]) / (3.0f * (apgrid[i] - apgrid[i - 1]));
}

void Model::kpspl3(float kp, float kpterms[3]) {
    static const float node[8] = {-10.f, -8.f, 0.f, 2.f, 5.f, 8.f, 18.f, 20.f};
    float x = std::max(kp, 0.0f);
    x = std::min(x, 8.0f);
    kpterms[0] = kpterms[1] = kpterms[2] = 0.0f;
    float kpspl[7];
    for (int i = 0; i <= 6; ++i) {
        kpspl[i] = 0.0f;
        if (x >= node[i] && x < node[i + 1]) kpspl[i] = 1.0f;
    }
    for (int j = 2; j <= 3; ++j) {
        for (int i = 0; i <= 8 - j - 1; ++i) {
            kpspl[i] = kpspl[i] * (x - node[i]) / (node[i + j - 1] - node[i]) +
                       kpspl[i + 1] * (node[i + j] - x) / (node[i + j] - node[i + 1]);
        }
    }
    kpterms[0] = kpspl[0] + kpspl[1];
    kpterms[1] = kpspl[2];
    kpterms[2] = kpspl[3] + kpspl[4];
}

float Model::latwgt2(float mlat, float mlt, float kp0, float twidth) {
    static const float coeff[6] = {65.7633f, -4.60256f, -3.53915f, -1.99971f, -0.752193f, 0.972388f};
    const float pi = 3.141592653590f;
    // "dtor = pi/180.d0": folded in real(8), then stored as real(4).
    const float dtor = static_cast<float>(static_cast<double>(pi) / 180.0);
    const float mltrad = mlt * 15.0f * dtor;
    const float sinmlt = hsin(mltrad);
    const float cosmlt = hcos(mltrad);
    float kp = std::max(kp0, 0.0f);
    kp = std::min(kp, 8.0f);
    const float tlat = coeff[0] + coeff[1] * cosmlt + coeff[2] * sinmlt +
                       kp * (coeff[3] + coeff[4] * cosmlt + coeff[5] * sinmlt);
    return 1.0f / (1.0f + std::exp(-(std::fabs(mlat) - tlat) / twidth));
}

void Model::dwm07b(float mlt, float mlat, float kp, float* mmpwind, float* mzpwind) const {
    const ModelData& d = *d_;
    const int nmax = d.dwmNmax, mmax = d.dwmMmax, ld = nmax + 1;
    std::vector<double> dp(static_cast<std::size_t>(ld) * (mmax + 1), 0.0);
    std::vector<double> dv = dp, dw = dp;
    const double theta = (90.0 - static_cast<double>(mlat)) * kDwmDtor;
    alfbasis(d.alf, nmax, mmax, theta, dp.data(), dv.data(), dw.data(), ld);
    auto dvbar = [&](int n, int m) { return dv[static_cast<std::size_t>(n + m * ld)]; };
    auto dwbar = [&](int n, int m) { return dw[static_cast<std::size_t>(n + m * ld)]; };
    const double phi = static_cast<double>(mlt) * kDwmDtor * 15.0;
    std::vector<double> mc(mmax + 1), ms(mmax + 1);
    for (int m = 0; m <= mmax; ++m) {
        const double mphi = static_cast<double>(m) * phi;
        mc[m] = hcos(mphi);
        ms[m] = hsin(mphi);
    }
    std::vector<float> vsh0(d.nvshterm), vsh1(d.nvshterm);
    int iv = 0;
    for (int n = 1; n <= nmax; ++n) {
        vsh0[iv] = -static_cast<float>(dvbar(n, 0) * mc[0]);
        vsh0[iv + 1] = static_cast<float>(dwbar(n, 0) * mc[0]);
        vsh1[iv] = -vsh0[iv + 1];
        vsh1[iv + 1] = vsh0[iv];
        iv += 2;
        for (int m = 1; m <= mmax; ++m) {
            if (m > n) continue;
            vsh0[iv] = -static_cast<float>(dvbar(n, m) * mc[m]);
            vsh0[iv + 1] = static_cast<float>(dvbar(n, m) * ms[m]);
            vsh0[iv + 2] = static_cast<float>(dwbar(n, m) * ms[m]);
            vsh0[iv + 3] = static_cast<float>(dwbar(n, m) * mc[m]);
            vsh1[iv] = -vsh0[iv + 2];
            vsh1[iv + 1] = -vsh0[iv + 3];
            vsh1[iv + 2] = vsh0[iv];
            vsh1[iv + 3] = vsh0[iv + 1];
            iv += 4;
        }
    }
    float kpterms[3];
    kpspl3(kp, kpterms);
    const float latwgtterm = latwgt2(mlat, mlt, kp, d.twidth);
    std::vector<float> tv0(d.dwmNterm), tv1(d.dwmNterm);
    for (int it = 0; it < d.dwmNterm; ++it) {
        float t0 = 1.0f, t1 = 1.0f;
        const int a0 = d.termarr[static_cast<std::size_t>(3 * it)];
        const int a1 = d.termarr[static_cast<std::size_t>(3 * it + 1)];
        const int a2 = d.termarr[static_cast<std::size_t>(3 * it + 2)];
        if (a0 != 999) { t0 = t0 * vsh0[a0]; t1 = t1 * vsh1[a0]; }
        if (a1 != 999) { t0 = t0 * kpterms[a1]; t1 = t1 * kpterms[a1]; }
        if (a2 != 999) { t0 = t0 * latwgtterm; t1 = t1 * latwgtterm; }
        tv0[it] = t0;
        tv1[it] = t1;
    }
    *mmpwind = dotf(d.coeff.data(), tv0.data(), d.dwmNterm, 1);
    *mzpwind = dotf(d.coeff.data(), tv1.data(), d.dwmNterm, 1);
}

void Model::dwm07(int iyd, float sec, float alt, float glat, float glon, const float ap[2],
                  float dw[2]) const {
    const float kp = ap2kp(ap[1]);
    float mlat, mlon, f1e, f1n, f2e, f2n;
    gd2qd(glat, glon, &mlat, &mlon, &f1e, &f1n, &f2e, &f2n);
    const float day = static_cast<float>(iyd % 1000);
    const float ut = sec / 3600.0f;
    const float mlt = mltcalc(mlat, mlon, day, ut);
    float mmpwind, mzpwind;
    dwm07b(mlt, mlat, kp, &mmpwind, &mzpwind);
    dw[0] = f2n * mmpwind + f1n * mzpwind;
    dw[1] = f2e * mmpwind + f1e * mzpwind;
    const float profile = 1.0f + std::exp(-(alt - kDwmTalt) / d_->twidth);
    dw[0] = dw[0] / profile;
    dw[1] = dw[1] / profile;
}

}  // namespace hwm14
