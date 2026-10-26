#include "ffm_gravity.h"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <utility>
#include <deque>
#include <vector>

namespace astro::ffm {
namespace {

// Shape-specific tables contain only geometry and normalization constants.
// Coefficients remain in the caller's field, including changing tide fields.
struct PinesTable {
    int degree, order;
    std::vector<double> diagonal, subdiagonal, alpha, beta;
    std::vector<double> gp, gz, fgm, nmz;
    std::vector<double> fastGp, fastFgm, fastNmz;
    std::vector<double> V, W;
    double scaledMuR2 = -1.0;

    static size_t row(int n) { return size_t(n) * size_t(n + 1) / 2; }

    PinesTable(int d, int o) : degree(d), order(o),
        diagonal(d + 2), subdiagonal(d + 2),
        alpha(row(d + 2)), beta(row(d + 2)),
        gp(row(d + 1)), gz(d + 1), fgm(row(d + 1)), nmz(row(d + 1)),
        fastGp(row(d + 1)), fastFgm(row(d + 1)), fastNmz(row(d + 1)),
        V(row(d + 2)), W(row(d + 2))
    {
        // Every expression below is copied from the shipped recursion/sum.
        for (int n = 2; n <= degree + 1; ++n) {
            diagonal[n] = std::sqrt((2.0 * n + 1.0) / (2.0 * n));
            subdiagonal[n] = std::sqrt(2.0 * n + 1.0);
        }
        for (int m = 0; m <= std::min(order + 1, degree + 1); ++m) {
            for (int n = m + 2; n <= degree + 1; ++n) {
                double nm = (double)(n - m);
                double np = (double)(n + m);
                alpha[row(n) + m] = std::sqrt((2.0*n - 1.0) * (2.0*n + 1.0) / (nm * np));
                beta[row(n) + m] = std::sqrt((2.0*n + 1.0) * (nm - 1.0) * (np - 1.0) /
                                            ((2.0*n - 3.0) * nm * np));
            }
        }
        for (int n = 2; n <= degree; ++n) {
            double n2p1 = 2.0*n + 1.0;
            double n2p3 = 2.0*n + 3.0;
            gp[row(n)] = std::sqrt(n2p1 * (double)(n+1) * (double)(n+2) / (2.0 * n2p3));
            gz[n] = std::sqrt(n2p1 / n2p3);
            for (int m = 1; m <= std::min(n, order); ++m) {
                const size_t i = row(n) + m;
                gp[i] = std::sqrt(n2p1 * (double)(n+m+1) * (double)(n+m+2) / n2p3);
                if (m == 1) {
                    fgm[i] = std::sqrt(2.0 * n2p1 * (double)n * (double)(n+1) / n2p3);
                } else {
                    fgm[i] = std::sqrt(n2p1 * (double)(n-m+1) * (double)(n-m+2) / n2p3);
                }
                nmz[i] = (double)(n-m+1) * std::sqrt(n2p1 * (double)(n+m+1) /
                                                   (n2p3 * (double)(n-m+1)));
            }
        }
    }

    void scaleFastConstants(double muR2) {
        if (muR2 == scaledMuR2) return;
        scaledMuR2 = muR2;
        for (int n = 2; n <= degree; ++n) {
            const size_t base = row(n);
            fastGp[base] = -muR2 * gp[base];
            fastNmz[base] = -muR2 * (double)(n+1) * gz[n];
            for (int m = 1; m <= std::min(n, order); ++m) {
                fastGp[base + m] = muR2 * 0.5 * gp[base + m];
                fastFgm[base + m] = muR2 * 0.5 * fgm[base + m];
                fastNmz[base + m] = -muR2 * nmz[base + m];
            }
        }
    }
};

PinesTable& pinesTable(int degree, int order) {
    // Retain each shape independently: alternating degree-70 gravity and
    // degree-30/4 tides never resizes the recurrence scratch. Deque growth
    // preserves existing references and coefficient storage.
    static thread_local std::deque<PinesTable> tables;
    for (auto& table : tables) {
        if (table.degree == degree && table.order == order) return table;
    }
    tables.emplace_back(degree, order);
    return tables.back();
}

void computePines(const Vec3& position, double R, PinesTable& t) {
    const double r = position.magnitude();
    const double r2 = r * r;
    const double xRr2 = position.x * R / r2;
    const double yRr2 = position.y * R / r2;
    const double zRr2 = position.z * R / r2;
    const double Rr_sq = (R / r) * (R / r);
    double* const V = t.V.data();
    double* const W = t.W.data();
    const auto row = PinesTable::row;
    V[0] = R / r;
    W[0] = 0.0;
    const double s3 = std::sqrt(3.0);
    V[1] = s3 * zRr2 * V[0];
    W[1] = 0.0;
    V[2] = s3 * xRr2 * V[0];
    W[2] = s3 * yRr2 * V[0];

    // Traverse rows contiguously; each row depends only on the preceding
    // two, so the compiler can vectorize V/W together without fast-math.
    for (int n = 2; n <= t.degree + 1; ++n) {
        const size_t base = row(n), prev = row(n-1), prev2 = row(n-2);
        const int end = std::min(n-2, t.order + 1);
        for (int m = 0; m <= end; ++m) {
            const double az = t.alpha[base+m] * zRr2;
            const double br = t.beta[base+m] * Rr_sq;
            V[base+m] = az * V[prev+m] - br * V[prev2+m];
            W[base+m] = az * W[prev+m] - br * W[prev2+m];
        }
        const double sub = t.subdiagonal[n] * zRr2;
        V[base+n-1] = sub * V[prev+n-1];
        W[base+n-1] = sub * W[prev+n-1];
        const double diag = t.diagonal[n];
        V[base+n] = diag * (xRr2 * V[prev+n-1] - yRr2 * W[prev+n-1]);
        W[base+n] = diag * (xRr2 * W[prev+n-1] + yRr2 * V[prev+n-1]);
    }
}

// Two doubles in one register: wasm f64x2 under -msimd128 (NEON natively).
// Vector operations are element-wise IEEE operations, so each lane computes
// exactly the scalar expression, in the same order.
typedef double Lanes __attribute__((vector_size(16)));
inline Lanes lanes(const double* p) { Lanes v; std::memcpy(&v, p, sizeof v); return v; }

// The harmonic sum over the degrees 2..maxDegree. Four accumulators take the
// orders round-robin (a0 also the order-0 terms and the tail): a0, a1 are the
// lanes of `low` and a2, a3 those of `high`, so a pair of orders goes to a
// pair of accumulators at once, and every accumulator receives the same terms
// in the same sequence as four scalar ones. `rows(n, base)` gives degree n's
// C and S rows.
template <class Rows>
Vec3 harmonicSum(int maxDegree, int maxOrder, PinesTable& t, double muR2, Rows rows) {
    t.scaleFastConstants(muR2);
    struct Accumulators { Lanes x, y, z; };
    Accumulators low{{0.0, 0.0}, {0.0, 0.0}, {0.0, 0.0}}, high = low;
    for (int n = 2; n <= maxDegree; ++n) {
        const size_t base = PinesTable::row(n);
        const double* const V = t.V.data() + PinesTable::row(n+1);
        const double* const W = t.W.data() + PinesTable::row(n+1);
        const auto row = rows(n, base);
        const double* const C = row.first;
        const double* const S = row.second;
        const double* const gp = t.fastGp.data() + base;
        const double* const fgm = t.fastFgm.data() + base;
        const double* const nmz = t.fastNmz.data() + base;
        low.x[0] += gp[0] * C[0] * V[1];
        low.y[0] += gp[0] * C[0] * W[1];
        low.z[0] += nmz[0] * C[0] * V[0];
        auto pair = [&](int m, Accumulators& a) {
            const Lanes c = lanes(C + m), s = lanes(S + m);
            const Lanes vNext = lanes(V + m + 1), wNext = lanes(W + m + 1);
            const Lanes vPrevious = lanes(V + m - 1), wPrevious = lanes(W + m - 1);
            const Lanes g = lanes(gp + m), f = lanes(fgm + m);
            a.x += -g * (c * vNext + s * wNext)
                   + f * (c * vPrevious + s * wPrevious);
            a.y += g * (s * vNext - c * wNext)
                   + f * (s * vPrevious - c * wPrevious);
            a.z += lanes(nmz + m) * (c * lanes(V + m) + s * lanes(W + m));
        };
        const int end = std::min(n, maxOrder);
        int m = 1;
        for (; m + 3 <= end; m += 4) {
            pair(m, low); pair(m+2, high);
        }
        for (; m <= end; ++m) {
            const double c = C[m], s = S[m];
            low.x[0] += -gp[m] * (c * V[m+1] + s * W[m+1])
                        + fgm[m] * (c * V[m-1] + s * W[m-1]);
            low.y[0] += gp[m] * (s * V[m+1] - c * W[m+1])
                        + fgm[m] * (s * V[m-1] - c * W[m-1]);
            low.z[0] += nmz[m] * (c * V[m] + s * W[m]);
        }
    }
    const Vec3 a0(low.x[0], low.y[0], low.z[0]), a1(low.x[1], low.y[1], low.z[1]);
    const Vec3 a2(high.x[0], high.y[0], high.z[0]), a3(high.x[1], high.y[1], high.z[1]);
    return (a0 + a1) + (a2 + a3);
}

Vec3 fastSum(const ExtendedGravityField& field, PinesTable& t, double muR2) {
    return harmonicSum(field.maxDegree, field.maxOrder, t, muR2, [&](int n, size_t) {
        return std::pair<const double*, const double*>(field.Cnm[n].data(), field.Snm[n].data());
    });
}

Vec3 fastFlatSum(const ExtendedGravityField& field, const double* flatC,
                   const double* flatS, PinesTable& t, double muR2) {
    return harmonicSum(field.maxDegree, field.maxOrder, t, muR2, [&](int, size_t base) {
        return std::pair<const double*, const double*>(flatC + base, flatS + base);
    });
}

} // namespace

void prepareGravity(int degree, int order) {
    if (degree >= 2) (void)pinesTable(degree, order);
}

GravityAcceleration computeGravity(const Vec3& position,
                                   const ExtendedGravityField& field,
                                   double /* jd */) {
    GravityAcceleration result;
    const double r = position.magnitude();
    if (r < 100.0) return result;

    const double mu = field.mu;
    const double R = field.referenceRadius;
    const double r3 = r * r * r;
    result.pointMass = position * (-mu / r3);
    result.total = result.pointMass;
    result.valid = true;
    if (field.maxDegree < 2) return result;

    auto& table = pinesTable(field.maxDegree, field.maxOrder);
    computePines(position, R, table);
    const Vec3 harmonic = fastSum(field, table, mu / (R * R));
    result.zonalHarmonics = harmonic;
    result.total = result.pointMass + harmonic;
    result.degreeUsed = field.maxDegree;
    result.orderUsed = field.maxOrder;
    return result;
}

Vec3 computeFlatGravity(const Vec3& position,
                        const ExtendedGravityField& metadata,
                        const double* C, const double* S) {
    if (position.magnitude() < 100.0 || metadata.maxDegree < 2) return {};
    auto& table = pinesTable(metadata.maxDegree, metadata.maxOrder);
    computePines(position, metadata.referenceRadius, table);
    const double muR2 = metadata.mu /
        (metadata.referenceRadius * metadata.referenceRadius);
    return fastFlatSum(metadata, C, S, table, muR2);
}

} // namespace astro::ffm
