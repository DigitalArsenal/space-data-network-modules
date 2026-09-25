// Compares the C++ port with the FORTRAN oracle (oracle/oracle.f90 linked
// against the unmodified nrl/hwm14.f90) on oracle/fixtures inputs.
// Usage: oracle_parity <inputs.bin> <expected.bin> [max_abs_diff_m_per_s]
// Without a tolerance every float must match bit for bit.
#include "../hwm14.hpp"

#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <iterator>
#include <string>
#include <vector>

#pragma STDC FP_CONTRACT OFF
#if defined(__clang__)
#pragma clang fp contract(off)
#elif defined(__GNUC__)
#pragma GCC optimize("fp-contract=off")
#endif

namespace {

std::vector<unsigned char> slurp(const char* path) {
    std::ifstream f(path, std::ios::binary);
    return std::vector<unsigned char>(std::istreambuf_iterator<char>(f), {});
}

struct Cursor {
    const unsigned char* p;
    int32_t i32() { int32_t v; std::memcpy(&v, p, 4); p += 4; return v; }
    float f32() { float v; std::memcpy(&v, p, 4); p += 4; return v; }
};

uint32_t bits(float x) { uint32_t u; std::memcpy(&u, &x, 4); return u; }

}  // namespace

int main(int argc, char** argv) {
    if (argc < 3) {
        std::fprintf(stderr, "usage: oracle_parity inputs.bin expected.bin [tolerance]\n");
        return 2;
    }
    const bool exact = argc < 4;
    const double tol = exact ? 0.0 : std::atof(argv[3]);
    const std::vector<unsigned char> in = slurp(argv[1]);
    const std::vector<unsigned char> ex = slurp(argv[2]);
    Cursor c{in.data()};
    const int ngeo = c.i32();
    std::vector<int32_t> iyd(ngeo);
    std::vector<float> g(static_cast<std::size_t>(ngeo) * 5);
    for (int k = 0; k < ngeo; ++k) {
        iyd[k] = c.i32();
        for (int j = 0; j < 5; ++j) g[static_cast<std::size_t>(k) * 5 + j] = c.f32();
    }
    const int nmag = c.i32();
    std::vector<float> m(static_cast<std::size_t>(nmag) * 3);
    for (float& v : m) v = c.f32();
    const int nap = c.i32();
    std::vector<float> apv(nap);
    for (float& v : apv) v = c.f32();

    const std::size_t expectedFloats = static_cast<std::size_t>(ngeo) * 15 + static_cast<std::size_t>(nmag) * 2 +
                                       static_cast<std::size_t>(nap) * 5;
    if (ex.size() != expectedFloats * 4) {
        std::fprintf(stderr, "expected file has %zu bytes, want %zu\n", ex.size(), expectedFloats * 4);
        return 2;
    }
    std::vector<float> got;
    got.reserve(expectedFloats);

    hwm14::Model model;
    for (int k = 0; k < ngeo; ++k) {
        const float* p = &g[static_cast<std::size_t>(k) * 5];
        float ap[2] = {0.0f, p[4]};
        float w[2], qw[2], dw[2], q[6];
        model.hwm14(iyd[k], p[0], p[1], p[2], p[3], 0, 0, 0, ap, w);
        model.dwm07(iyd[k], p[0], p[1], p[2], p[3], ap, dw);
        ap[1] = -1.0f;
        model.hwm14(iyd[k], p[0], p[1], p[2], p[3], 0, 0, 0, ap, qw);
        model.gd2qd(p[2], p[3], &q[0], &q[1], &q[2], &q[3], &q[4], &q[5]);
        const float mlt = model.mltcalc(q[0], q[1], static_cast<float>(iyd[k] % 1000), p[0] / 3600.0f);
        float qt[2];
        model.hwmqt(iyd[k], p[0], p[1], p[2], p[3], 0, 0, 0, ap, qt);
        const float row[15] = {w[0], w[1], qw[0], qw[1], dw[0], dw[1], q[0], q[1], q[2], q[3], q[4], q[5], mlt, qt[0], qt[1]};
        got.insert(got.end(), row, row + 15);
    }
    for (int k = 0; k < nmag; ++k) {
        const float* p = &m[static_cast<std::size_t>(k) * 3];
        float mmp, mzp;
        model.dwm07b(p[0], p[1], p[2], &mmp, &mzp);
        got.push_back(mmp);
        got.push_back(mzp);
    }
    for (int k = 0; k < nap; ++k) {
        const float a = apv[k];
        float kpt[3];
        hwm14::Model::kpspl3(a / 40.0f, kpt);
        got.push_back(hwm14::Model::ap2kp(a));
        got.insert(got.end(), kpt, kpt + 3);
        got.push_back(hwm14::Model::latwgt2(a * 0.4f - 84.0f, a / 17.0f, a / 40.0f, 4.0f));
    }

    std::size_t mismatches = 0;
    double worst = 0.0;
    for (std::size_t i = 0; i < expectedFloats; ++i) {
        float e;
        std::memcpy(&e, &ex[i * 4], 4);
        const float a = got[i];
        const bool same = exact ? bits(a) == bits(e) : std::fabs(double(a) - double(e)) <= tol;
        worst = std::max(worst, std::fabs(double(a) - double(e)));
        if (!same) {
            if (mismatches < 10) {
                std::fprintf(stderr, "mismatch at float %zu: got %.9g (0x%08x) want %.9g (0x%08x)\n", i, a, bits(a), e,
                             bits(e));
            }
            ++mismatches;
        }
    }
    std::printf("%s parity: %zu floats (%d geo, %d mag, %d ap), %zu mismatches, max |diff| %.3g\n",
                exact ? "bit-exact" : "tolerance", expectedFloats, ngeo, nmag, nap, mismatches, worst);
    return mismatches == 0 ? 0 : 1;
}
