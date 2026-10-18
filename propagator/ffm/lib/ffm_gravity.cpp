#include "ffm_gravity.h"

#include <algorithm>
#include <cmath>
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

Vec3 fastSum(const ExtendedGravityField& field, PinesTable& t, double muR2) {
    t.scaleFastConstants(muR2);
    Vec3 a0, a1, a2, a3;
    for (int n = 2; n <= field.maxDegree; ++n) {
        const size_t base = PinesTable::row(n);
        const double* const V = t.V.data() + PinesTable::row(n+1);
        const double* const W = t.W.data() + PinesTable::row(n+1);
        const double* const C = field.Cnm[n].data();
        const double* const S = field.Snm[n].data();
        const double* const gp = t.fastGp.data() + base;
        const double* const fgm = t.fastFgm.data() + base;
        const double* const nmz = t.fastNmz.data() + base;
        a0.x += gp[0] * C[0] * V[1];
        a0.y += gp[0] * C[0] * W[1];
        a0.z += nmz[0] * C[0] * V[0];
        auto add = [&](int m, Vec3& a) {
            const double c = C[m], s = S[m];
            a.x += -gp[m] * (c * V[m+1] + s * W[m+1])
                   + fgm[m] * (c * V[m-1] + s * W[m-1]);
            a.y += gp[m] * (s * V[m+1] - c * W[m+1])
                   + fgm[m] * (s * V[m-1] - c * W[m-1]);
            a.z += nmz[m] * (c * V[m] + s * W[m]);
        };
        const int end = std::min(n, static_cast<int>(field.maxOrder));
        int m = 1;
        for (; m + 3 <= end; m += 4) {
            add(m, a0); add(m+1, a1); add(m+2, a2); add(m+3, a3);
        }
        for (; m <= end; ++m) add(m, a0);
    }
    return (a0 + a1) + (a2 + a3);
}

Vec3 fastFlatSum(const ExtendedGravityField& field, const double* flatC,
                   const double* flatS, PinesTable& t, double muR2) {
    t.scaleFastConstants(muR2);
    Vec3 a0, a1, a2, a3;
    for (int n = 2; n <= field.maxDegree; ++n) {
        const size_t base = PinesTable::row(n);
        const double* const V = t.V.data() + PinesTable::row(n+1);
        const double* const W = t.W.data() + PinesTable::row(n+1);
        const double* const C = flatC + base;
        const double* const S = flatS + base;
        const double* const gp = t.fastGp.data() + base;
        const double* const fgm = t.fastFgm.data() + base;
        const double* const nmz = t.fastNmz.data() + base;
        a0.x += gp[0] * C[0] * V[1];
        a0.y += gp[0] * C[0] * W[1];
        a0.z += nmz[0] * C[0] * V[0];
        auto add = [&](int m, Vec3& a) {
            const double c = C[m], s = S[m];
            a.x += -gp[m] * (c * V[m+1] + s * W[m+1])
                   + fgm[m] * (c * V[m-1] + s * W[m-1]);
            a.y += gp[m] * (s * V[m+1] - c * W[m+1])
                   + fgm[m] * (s * V[m-1] - c * W[m-1]);
            a.z += nmz[m] * (c * V[m] + s * W[m]);
        };
        const int end = std::min(n, static_cast<int>(field.maxOrder));
        int m = 1;
        for (; m + 3 <= end; m += 4) {
            add(m, a0); add(m+1, a1); add(m+2, a2); add(m+3, a3);
        }
        for (; m <= end; ++m) add(m, a0);
    }
    return (a0 + a1) + (a2 + a3);
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
