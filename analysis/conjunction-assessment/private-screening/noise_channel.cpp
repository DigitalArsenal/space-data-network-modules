// The noise-channel measurement (PROTOCOL-NOISE.md): what the requester A, who
// holds the secret key, can read from the noise of the returned S2 response.
// It runs the shipped S2 response (protocol.cpp's maskedDistance, noise and
// mask on) for the registered population and prints one JSON document of rows
// (readings, known A features, targets, distance histograms), the dictionary
// arm's fingerprints and the controls. The estimators and gates are applied by
// tests/privateScreeningNoiseChannel.e2e.mjs.
//
// The driver is one translation unit with the fork's he_encryption.cpp
// (included below) built with -fno-access-control, so that A, as the key
// holder, reaches its own decryptor's phase routine. No fork file or protocol
// file changes.
//
//   private_screening_noise [--seed4 1600] [--dict-reps 5] [--targets 200]
//                           [--repeat 30] [--exact-dumps 2] [--small 0]
#include "he_encryption.cpp"

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <functional>
#include <thread>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <random>
#include <string>
#include <vector>

#include "seal/util/blake2.h"

using namespace flatbuffers::he;
using Bytes = std::vector<uint8_t>;
using Clock = std::chrono::steady_clock;

namespace {

constexpr double kMuKm = 398600.4418;
constexpr double kPi = 3.14159265358979323846;
constexpr uint32_t kN = 8192;
constexpr uint32_t kCoordBound = 24, kMaskBound = 120;
constexpr int kHistBins = 416;  // 1/16 octave over log2 d in [0, 26)

// ---- orbits (the test-only oracle of protocol.cpp) ----
struct V3 { double x, y, z; };
V3 add(V3 a, V3 b) { return {a.x + b.x, a.y + b.y, a.z + b.z}; }
V3 mul(V3 a, double s) { return {a.x * s, a.y * s, a.z * s}; }
V3 cross(V3 a, V3 b) { return {a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x}; }
V3 unit(V3 a) { return mul(a, 1.0 / std::sqrt(a.x * a.x + a.y * a.y + a.z * a.z)); }
using P3 = std::array<int64_t, 3>;
struct Orbit {
  double r, n; V3 c, d; double tc;
  V3 at(double t) const { const double u = n * (t - tc); return add(mul(c, r * std::cos(u)), mul(d, r * std::sin(u))); }
};
Orbit circular(double r, V3 normal, V3 c, double tc) {
  normal = unit(normal);
  return {r, std::sqrt(kMuKm / (r * r * r)), c, cross(normal, c), tc};
}
// Positions for steps [s0, s1).
std::vector<P3> sampleRange(const Orbit& o, size_t s0, size_t s1) {
  std::vector<P3> p(s1 - s0);
  for (size_t j = s0; j < s1; ++j) {
    const V3 q = o.at((double)j);
    p[j - s0] = {std::llround(q.x * 1e3), std::llround(q.y * 1e3), std::llround(q.z * 1e3)};
  }
  return p;
}

// ---- the responder's keyed generators (as protocol.cpp, 2f) ----
constexpr uint8_t kTestKeyEta[32] = {0x19, 0x20, 0x26, 0x11, 0x06, 0xe7, 0xa0, 0x01, 0x5d, 0xa1, 0xc0, 0xde, 0x00, 0x00, 0x00, 0x01,
                                     0x70, 0x72, 0x69, 0x76, 0x61, 0x74, 0x65, 0x2d, 0x73, 0x63, 0x72, 0x65, 0x65, 0x6e, 0x19, 0x01};
constexpr uint8_t kTestKeyRho[32] = {0x19, 0x20, 0x26, 0x11, 0x06, 0x5d, 0xa0, 0x02, 0x5d, 0xa1, 0xc0, 0xde, 0x00, 0x00, 0x00, 0x02,
                                     0x70, 0x72, 0x69, 0x76, 0x61, 0x74, 0x65, 0x2d, 0x73, 0x63, 0x72, 0x65, 0x65, 0x6e, 0x19, 0x02};
struct PrfInput { uint64_t domain, requester, object, block, slot; };
double keyedUniform(uint64_t objectId, uint64_t step) {
  uint8_t out[8]; uint64_t h;
  PrfInput in{1, 1, objectId, 0, step};
  blake2b(out, sizeof out, &in, sizeof in, kTestKeyEta, 32);
  std::memcpy(&h, out, 8);
  return ((double)(h >> 11) + 0.5) / 9007199254740992.0 - 0.5;
}
void keyedMask(uint64_t objectId, uint64_t block, uint64_t slot, WideInt* w) {  // rho in [2^100, 2^119)
  uint8_t out[16]; uint64_t m0, m1;
  PrfInput in{2, 1, objectId, block, slot};
  blake2b(out, sizeof out, &in, sizeof in, kTestKeyRho, 32);
  std::memcpy(&m0, out, 8); std::memcpy(&m1, out + 8, 8);
  m1 = (m1 & ((1ULL << 55) - 1)) | (1ULL << 36);
  w->negative = false; w->magnitude = {m0, m1, 0};
}
typedef __int128 i128;
i128 wideToI128(const WideInt& w) {
  const unsigned __int128 m = ((unsigned __int128)w.magnitude[1] << 64) | w.magnitude[0];
  return w.negative ? -(i128)m : (i128)m;
}

// ---- the noise reading: what A, the key holder, reads from one response ----
constexpr int kReadingLen = 19;
struct Raw { std::vector<uint64_t> limbsLane0; };  // d residues, lane 0, limb-major (for the exact check)
// Fills r[0..18]; optionally the lane-0 residues; returns log2 max|d| per lane in lmax.
void readNoise(HEContext& A, const Bytes& ct, double* r, Raw* raw, double* lmaxOut, int* sealBudgetFromD) {
  HEContextImpl& I = *A.impl_;
  HEContextImpl::Ciphertexts cts;
  uint32_t bb = 0;
  if (!I.Unpack(ct.data(), ct.size(), &cts, &bb)) { std::fprintf(stderr, "unpack failed\n"); std::exit(3); }
  r[0] = A.NoiseBudget(ct.data(), ct.size());
  for (int lane = 0; lane < 3; ++lane) {
    auto& L = I.lanes_[lane];
    r[1 + lane] = L.decryptor->invariant_noise_budget(cts[lane]);
    auto cd = L.context->get_context_data(cts[lane].parms_id());
    const auto& q = cd->parms().coeff_modulus();
    const size_t nl = q.size();
    const uint64_t t = cd->parms().plain_modulus().value();
    std::vector<uint64_t> buf(nl * kN, 0);
    seal::util::RNSIter it(buf.data(), kN);
    L.decryptor->dot_product_ct_sk_array(cts[lane], it, seal::MemoryManager::GetPool());
    // d = t * phase mod q (per limb), then the centered value as a fraction of Q.
    std::vector<long double> invf(nl);
    long double log2Q = 0;
    for (size_t j = 0; j < nl; ++j) {
      uint64_t qhat = 1;
      for (size_t k = 0; k < nl; ++k) if (k != j) qhat = seal::util::multiply_uint_mod(qhat, q[k].value() % q[j].value(), q[j]);
      uint64_t inv = 0;
      if (!seal::util::try_invert_uint_mod(qhat, q[j], inv)) { std::fprintf(stderr, "invert failed\n"); std::exit(3); }
      invf[j] = (long double)inv;
      log2Q += std::log2((long double)q[j].value());
    }
    std::vector<double> l2(kN);
    double linf = 0, sumsq = 0;
    for (size_t i = 0; i < kN; ++i) {
      long double s = 0;
      for (size_t j = 0; j < nl; ++j) {
        const uint64_t dj = seal::util::multiply_uint_mod(buf[j * kN + i], t % q[j].value(), q[j]);
        if (raw && lane == 0) raw->limbsLane0.push_back(dj);
        const uint64_t u = seal::util::multiply_uint_mod(dj, (uint64_t)invf[j], q[j]);
        s += (long double)u / (long double)q[j].value();
      }
      s -= std::floor(s + 0.5L);  // centered fraction of Q in [-0.5, 0.5)
      const double a = std::fabs((double)s);
      linf = std::max(linf, a);
      sumsq += a * a;
      l2[i] = std::log2(std::max(a, 1e-30)) + (double)log2Q;
    }
    const double lq = (double)log2Q;
    std::vector<double> sorted = l2;
    std::nth_element(sorted.begin(), sorted.begin() + kN / 2, sorted.end());
    const double p50 = sorted[kN / 2];
    std::nth_element(sorted.begin(), sorted.begin() + (size_t)(kN * 0.9), sorted.end());
    const double p90 = sorted[(size_t)(kN * 0.9)];
    double meanlog = 0;
    for (double v : l2) meanlog += v;
    meanlog /= kN;
    const int o = 4 + lane * 5;
    r[o] = std::log2(std::max(linf, 1e-30)) + lq;
    r[o + 1] = 0.5 * std::log2(std::max(sumsq / kN, 1e-60)) + lq;
    r[o + 2] = meanlog; r[o + 3] = p50; r[o + 4] = p90;
    if (lmaxOut) lmaxOut[lane] = r[o];
    if (sealBudgetFromD && lane == 0) *sealBudgetFromD = (int)std::floor(lq - r[o] - 1);
  }
}

// ---- the exact noise polynomial w (PROTOCOL-NOISE.md section 7) ----
// phase = Delta m + w with Delta = floor(q/t) and m the decrypted plaintext
// polynomial, so w = (d + r m) / t exactly (d = [t phase]_q, r = q mod t),
// evaluated in the first two RNS limbs (|w| < 2^81 < q0 q1 / 2).
typedef unsigned __int128 u128;
struct CoefOut {
  std::vector<double> w[3];      // coefficient domain, per lane
  std::vector<double> slot[3];   // w mod t decoded by the lane's batch encoder, centered
  std::vector<uint64_t> m[3];    // the decrypted plaintext polynomial
  double log2Linf[3] = {0, 0, 0};
};
void exactW(HEContext& A, const Bytes& ct, CoefOut* out) {
  HEContextImpl& I = *A.impl_;
  HEContextImpl::Ciphertexts cts;
  uint32_t bb = 0;
  if (!I.Unpack(ct.data(), ct.size(), &cts, &bb)) { std::fprintf(stderr, "unpack failed\n"); std::exit(3); }
  for (int lane = 0; lane < 3; ++lane) {
    auto& L = I.lanes_[lane];
    auto cd = L.context->get_context_data(cts[lane].parms_id());
    const auto& q = cd->parms().coeff_modulus();
    const size_t nl = q.size();
    const uint64_t t = cd->parms().plain_modulus().value();
    std::vector<uint64_t> buf(nl * kN, 0);
    seal::util::RNSIter it(buf.data(), kN);
    L.decryptor->dot_product_ct_sk_array(cts[lane], it, seal::MemoryManager::GetPool());
    seal::Plaintext pt;
    L.decryptor->decrypt(cts[lane], pt);
    // d = [t (c0 + c1 s)]_q centered. Responses: a double from the RNS fraction (30 bits of
    // precision, d ~ 2^140). Fresh ciphertexts (|d| < 2^110): exact from the first two limbs.
    // The slot image uses w = (d + r m) / t (r = Q mod t), exact in two limbs (|w| < 2^81).
    std::vector<uint64_t> invj(nl);
    for (size_t j = 0; j < nl; ++j) {
      uint64_t qhat = 1;
      for (size_t k = 0; k < nl; ++k) if (k != j) qhat = seal::util::multiply_uint_mod(qhat, q[k].value() % q[j].value(), q[j]);
      if (!seal::util::try_invert_uint_mod(qhat, q[j], invj[j])) { std::fprintf(stderr, "invert failed\n"); std::exit(3); }
    }
    long double log2Q = 0;
    for (size_t j = 0; j < nl; ++j) log2Q += std::log2((long double)q[j].value());
    const long double Qf = std::exp2(log2Q);
    u128 rt = 1;
    for (size_t j = 0; j < nl; ++j) rt = (rt * (q[j].value() % t)) % t;
    const uint64_t r = (uint64_t)rt;
    uint64_t tinv[2], rj[2], q0inv = 0;
    for (int j = 0; j < 2; ++j) {
      if (!seal::util::try_invert_uint_mod(t % q[j].value(), q[j], tinv[j])) { std::fprintf(stderr, "t invert failed\n"); std::exit(3); }
      rj[j] = r % q[j].value();
    }
    seal::util::try_invert_uint_mod(q[0].value() % q[1].value(), q[1], q0inv);
    const i128 q0q1 = (i128)q[0].value() * q[1].value();
    out->w[lane].assign(kN, 0); out->slot[lane].assign(kN, 0); out->m[lane].assign(kN, 0);
    std::vector<double> dsmall(kN, 0.0);
    seal::Plaintext pw(kN);
    double linf = 0;
    for (size_t i = 0; i < kN; ++i) {
      const uint64_t mi = i < pt.coeff_count() ? pt[i] : 0;
      out->m[lane][i] = mi;
      long double s = 0;
      uint64_t d01[2], w01[2];
      for (size_t j = 0; j < nl; ++j) {
        const uint64_t dj = seal::util::multiply_uint_mod(buf[j * kN + i], t % q[j].value(), q[j]);
        const uint64_t u = seal::util::multiply_uint_mod(dj, invj[j], q[j]);
        s += (long double)u / (long double)q[j].value();
        if (j < 2) {
          d01[j] = dj;
          const uint64_t x = seal::util::add_uint_mod(dj, seal::util::multiply_uint_mod(rj[j], mi % q[j].value(), q[j]), q[j]);
          w01[j] = seal::util::multiply_uint_mod(x, tinv[j], q[j]);
        }
      }
      const long double kf = std::floor(s + 0.5L);
      const double dv = (double)((s - kf) * Qf);
      out->w[lane][i] = dv;
      linf = std::max(linf, std::fabs(dv));
      auto crt2 = [&](const uint64_t* v) {
        const uint64_t diff = seal::util::sub_uint_mod(v[1] % q[1].value(), v[0] % q[1].value(), q[1]);
        const uint64_t kk = seal::util::multiply_uint_mod(diff, q0inv, q[1]);
        i128 x = (i128)v[0] + (i128)q[0].value() * kk;
        if (x > q0q1 / 2) x -= q0q1;
        return x;
      };
      dsmall[i] = (double)crt2(d01);
      const i128 w = crt2(w01);
      i128 wm = w % (i128)t; if (wm < 0) wm += t;
      pw[i] = (uint64_t)wm;
    }
    { double ms = 0; for (double v : dsmall) ms = std::max(ms, std::fabs(v)); if (ms < std::exp2(76.0)) { out->w[lane] = dsmall; linf = ms; } }  // fresh: exact
    out->log2Linf[lane] = std::log2(std::max(linf, 1.0));
    std::vector<uint64_t> sl;
    L.batch_encoder->decode(pw, sl);
    for (size_t i = 0; i < kN; ++i) out->slot[lane][i] = sl[i] > t / 2 ? (double)sl[i] - (double)t : (double)sl[i];
  }
}

// ---- A's side: encrypted blocks, and B's response ----
struct Setup {
  HEContext a, b;
  uint64_t pad = 0;
};
Bytes encryptVec(const HEContext& a, const std::vector<int64_t>& v) {
  Bytes ct = a.EncryptInt64Vector(v, kCoordBound);
  if (ct.empty()) { std::fprintf(stderr, "A encrypt refused: %s\n", a.LastError().message.c_str()); std::exit(3); }
  return ct;
}
struct Params { int64_t raised2, noiseS; double beta; };
struct Response {
  Bytes ct; std::vector<WideInt> rho; std::vector<int64_t> eta;
  double bMs = 0;
};
// B's S2 response over block w for its track positions bp (steps [w kN, ...)); the
// shipped form: eta (keyed Laplace) and rho (keyed mask) each a fresh encryption.
Response respond(const HEContext& bCtx, const std::vector<Bytes>& aBlock, const std::vector<P3>& bp, size_t w, uint64_t objectId, const Params& P, size_t totalSteps) {
  const auto t0 = Clock::now();
  Response R;
  std::vector<int64_t> bk[3] = {std::vector<int64_t>(kN, 0), std::vector<int64_t>(kN, 0), std::vector<int64_t>(kN, 0)};
  R.eta.assign(kN, 0); R.rho.resize(kN);
  for (size_t j = 0; j < kN; ++j) {
    const size_t s = w * kN + j;
    if (s < totalSteps && j < bp.size()) for (int k = 0; k < 3; ++k) bk[k][j] = bp[j][k];
    keyedMask(objectId, w, j, &R.rho[j]);
    const double x = keyedUniform(objectId, s);
    double lap = -P.beta * (x < 0 ? -1.0 : 1.0) * std::log(1 - 2 * std::fabs(x));
    lap = std::max(-(double)P.noiseS, std::min((double)P.noiseS, lap));
    R.eta[j] = std::llround(lap);
  }
  auto chk = [](const Bytes& r, const char* what) { if (r.empty()) { std::fprintf(stderr, "%s refused\n", what); std::exit(3); } };
  Bytes eb[3];
  for (int k = 0; k < 3; ++k) { eb[k] = bCtx.EncryptInt64Vector(bk[k], kCoordBound); chk(eb[k], "enc b"); }
  Bytes emask = bCtx.EncryptWideVector(R.rho, kMaskBound); chk(emask, "enc mask");
  Bytes acc;
  for (int k = 0; k < 3; ++k) {
    Bytes d = bCtx.Sub(aBlock[k].data(), aBlock[k].size(), eb[k].data(), eb[k].size()); chk(d, "sub");
    Bytes sq = bCtx.Multiply(d, d); chk(sq, "mul");
    acc = k ? bCtx.Add(acc, sq) : sq; chk(acc, "add");
  }
  acc = bCtx.SubPlain(acc.data(), acc.size(), P.raised2); chk(acc, "subplain");
  Bytes eeta = bCtx.EncryptInt64Vector(R.eta, 26); chk(eeta, "enc eta");
  acc = bCtx.Add(acc, eeta); chk(acc, "add eta");
  R.ct = bCtx.Add(acc, emask); chk(R.ct, "add mask");
  R.bMs = std::chrono::duration<double, std::milli>(Clock::now() - t0).count();
  return R;
}

// ---- one measured row ----
struct Row {
  std::string set; int id = 0, rep = 0, w = 0;
  double reading[kReadingLen]; double known[6]; double target[7];
  std::vector<int> hist; size_t valueMismatches = 0;
  int sealBudgetFromD = 0;
};
Row measure(HEContext& A, const HEContext& B, const std::vector<std::vector<Bytes>>& aBlocks, const std::vector<std::array<P3, 1>>*, const std::vector<P3>& aTrack,
            const std::vector<P3>& bBlock, size_t w, uint64_t objectId, const Params& P, size_t totalSteps, const std::string& set, int id, int rep,
            double rprime, Raw* raw, CoefOut* co = nullptr) {
  Row row; row.set = set; row.id = id; row.rep = rep; row.w = (int)w;
  Response R = respond(B, aBlocks[w], bBlock, w, objectId, P, totalSteps);
  readNoise(A, R.ct, row.reading, raw, nullptr, &row.sealBudgetFromD);
  if (co) exactW(A, R.ct, co);
  std::vector<WideInt> dec = A.DecryptWideVector(R.ct.data(), R.ct.size());
  const size_t n = std::min<size_t>(kN, totalSteps - w * kN);
  row.hist.assign(kHistBins, 0);
  double minD = 1e30, sumLog = 0, ax = 0, ay = 0, az = 0, ar = 0, bx = 0, by = 0, bz = 0, br = 0, decLog = 0;
  for (size_t j = 0; j < n; ++j) {
    const P3& a = aTrack[w * kN + j]; const P3& b = bBlock[j];
    i128 d2 = 0;
    for (int k = 0; k < 3; ++k) { const i128 dk = (i128)a[k] - b[k]; d2 += dk * dk; }
    const i128 value = d2 - (i128)P.raised2 + R.eta[j];
    if (wideToI128(dec[j]) - wideToI128(R.rho[j]) != value) ++row.valueMismatches;
    const double d = std::sqrt((double)d2);
    minD = std::min(minD, d);
    const double l = std::log2(std::max(d, 1.0));
    sumLog += l;
    int bin = (int)std::floor(l * 16); bin = std::max(0, std::min(kHistBins - 1, bin));
    ++row.hist[bin];
    ax += a[0]; ay += a[1]; az += a[2]; ar += std::sqrt((double)a[0] * a[0] + (double)a[1] * a[1] + (double)a[2] * a[2]);
    bx += b[0]; by += b[1]; bz += b[2]; br += std::sqrt((double)b[0] * b[0] + (double)b[1] * b[1] + (double)b[2] * b[2]);
    const unsigned __int128 m = ((unsigned __int128)dec[j].magnitude[1] << 64) | dec[j].magnitude[0];
    decLog += std::log2((double)m + 1.0);
  }
  const double dn = (double)n;
  row.known[0] = (double)w; row.known[1] = ax / dn / 1e6; row.known[2] = ay / dn / 1e6; row.known[3] = az / dn / 1e6; row.known[4] = ar / dn / 1e6; row.known[5] = decLog / dn;
  row.target[0] = std::log2(std::max(minD, 1.0)); row.target[1] = sumLog / dn; row.target[2] = minD < rprime ? 1.0 : 0.0;
  row.target[3] = bx / dn / 1e6; row.target[4] = by / dn / 1e6; row.target[5] = bz / dn / 1e6; row.target[6] = br / dn / 1e6;
  return row;
}

void printRow(const Row& r, bool first) {
  std::printf("%s{\"set\":\"%s\",\"id\":%d,\"rep\":%d,\"w\":%d,\"vm\":%zu,\"sb\":%d,\"reading\":[", first ? "" : ",\n", r.set.c_str(), r.id, r.rep, r.w, r.valueMismatches, r.sealBudgetFromD);
  for (int i = 0; i < kReadingLen; ++i) std::printf("%s%.6f", i ? "," : "", r.reading[i]);
  std::printf("],\"known\":[");
  for (int i = 0; i < 6; ++i) std::printf("%s%.6f", i ? "," : "", r.known[i]);
  std::printf("],\"target\":[");
  for (int i = 0; i < 7; ++i) std::printf("%s%.6f", i ? "," : "", r.target[i]);
  std::printf("],\"hist\":[");
  for (size_t i = 0; i < r.hist.size(); ++i) std::printf("%s%d", i ? "," : "", r.hist[i]);
  std::printf("]}");
}

// ---- the coefficient-level reads (PROTOCOL-NOISE.md section 7) ----
using Vec = std::vector<double>;
// acc += scale * (m * e) in Z[x]/(x^n + 1)
void negacyc(const Vec& m, const Vec& e, Vec& acc, double scale) {
  const size_t n = kN;
  for (size_t i = 0; i < n; ++i) {
    const double mi = m[i] * scale;
    if (mi == 0) continue;
    const size_t lim = n - i;
    for (size_t j = 0; j < lim; ++j) acc[i + j] += mi * e[j];
    for (size_t j = lim; j < n; ++j) acc[i + j - n] -= mi * e[j];
  }
}
Vec unitVec(const Vec& v) {
  Vec o(v.size()); double mu = 0;
  for (double x : v) mu += x;
  mu /= (double)v.size();
  double ss = 0;
  for (size_t i = 0; i < v.size(); ++i) { o[i] = v[i] - mu; ss += o[i] * o[i]; }
  const double s = ss > 0 ? 1.0 / std::sqrt(ss) : 0.0;
  for (double& x : o) x *= s;
  return o;
}
double dot(const Vec& a, const Vec& b) { double s = 0; for (size_t i = 0; i < a.size(); ++i) s += a[i] * b[i]; return s; }
void printMatrix(const std::vector<Vec>& M) {
  std::printf("[");
  for (size_t i = 0; i < M.size(); ++i) { std::printf("%s[", i ? "," : ""); for (size_t j = 0; j < M[i].size(); ++j) std::printf("%s%.4f", j ? "," : "", M[i][j]); std::printf("]"); }
  std::printf("]");
}

void coefAnalysis(HEContext& A, const std::vector<std::vector<Bytes>>& aBlocks, const std::vector<std::vector<P3>>& cand,
                  std::vector<CoefOut>& sim, std::vector<CoefOut>& tgt, std::vector<CoefOut>& rep, int K, int reps, int threads) {
  HEContextImpl& I = *A.impl_;
  const double sq = std::sqrt((double)kN);
  // A's own noise eA_k and plaintext m_ak per lane (block 3).
  Vec eA[3][3], mA[3][3];
  for (int k = 0; k < 3; ++k) {
    CoefOut ca; exactW(A, aBlocks[3][k], &ca);
    for (int l = 0; l < 3; ++l) { eA[k][l] = ca.w[l]; mA[k][l].assign(ca.m[l].begin(), ca.m[l].end()); }
  }
  Vec aKnown[3];
  for (int l = 0; l < 3; ++l) { aKnown[l].assign(kN, 0.0); for (int k = 0; k < 3; ++k) negacyc(mA[k][l], eA[k][l], aKnown[l], 2.0); }
  // Candidate signal S[c][l] = -2 sum_k m_b'k * eA_k.
  std::vector<std::array<Vec, 3>> S(K);
  {
    std::vector<std::array<std::array<Vec, 3>, 3>> mB(K);  // [c][l][k]
    for (int c = 0; c < K; ++c) for (int l = 0; l < 3; ++l) {
      const uint64_t t = I.lanes_[l].context->first_context_data()->parms().plain_modulus().value();
      for (int k = 0; k < 3; ++k) {
        std::vector<uint64_t> res(kN);
        for (size_t j = 0; j < kN; ++j) { const int64_t x = cand[c][j][k]; res[j] = x >= 0 ? (uint64_t)x % t : t - ((uint64_t)(-x) % t); }
        seal::Plaintext pt;
        I.lanes_[l].batch_encoder->encode(res, pt);
        mB[c][l][k].assign(kN, 0.0);
        for (size_t i = 0; i < pt.coeff_count() && i < kN; ++i) mB[c][l][k][i] = (double)pt[i];
      }
    }
    std::atomic<int> next{0};
    auto worker = [&]() {
      for (int c = next++; c < K; c = next++) for (int l = 0; l < 3; ++l) {
        S[c][l].assign(kN, 0.0);
        for (int k = 0; k < 3; ++k) negacyc(mB[c][l][k], eA[k][l], S[c][l], -2.0);
      }
    };
    std::vector<std::thread> pool;
    for (int i = 0; i < threads; ++i) pool.emplace_back(worker);
    for (auto& th : pool) th.join();
  }
  std::vector<std::array<Vec, 3>> Su(K);
  for (int c = 0; c < K; ++c) for (int l = 0; l < 3; ++l) Su[c][l] = unitVec(S[c][l]);
  // Diagnostics: sizes.
  double lw = 0, la = 0, ls = 0, le = 0;
  for (size_t i = 0; i < kN; ++i) {
    lw = std::max(lw, std::fabs(tgt[0].w[0][i])); la = std::max(la, std::fabs(aKnown[0][i]));
    ls = std::max(ls, std::fabs(S[0][0][i])); le = std::max(le, std::fabs(eA[0][0][i]));
  }
  std::printf("\"coef\":%s\n\"wLinfLog2Lane0\":%.3f,\"aKnownLinfLog2\":%.3f,\"signalLinfLog2\":%.3f,\"eALinfLog2\":%.3f,\n", "{",
              std::log2(lw), std::log2(la), std::log2(ls), std::log2(le + 1e-9));
  // E4: matched filter on the coefficient vector, per target.
  std::vector<Vec> e4(tgt.size(), Vec(K, 0.0));
  for (size_t t = 0; t < tgt.size(); ++t) for (int l = 0; l < 3; ++l) {
    Vec r = tgt[t].w[l];
    for (size_t i = 0; i < kN; ++i) r[i] -= aKnown[l][i];
    const Vec ru = unitVec(r);
    for (int c = 0; c < K; ++c) e4[t][c] += sq * dot(ru, Su[c][l]);
  }
  std::printf("\"e4\":"); printMatrix(e4); std::printf(",\n");
  // E3 and E3-NN in both domains.
  const char* names[2] = {"coef", "slot"};
  std::printf("\"e3\":%s", "{");
  std::vector<std::vector<Vec>> nnOut(2);
  for (int dom = 0; dom < 2; ++dom) {
    auto vecOf = [&](const CoefOut& co, int l) -> const Vec& { return dom == 0 ? co.w[l] : co.slot[l]; };
    const size_t ns = sim.size();
    // grand mean over the simulations
    Vec gm[3];
    for (int l = 0; l < 3; ++l) { gm[l].assign(kN, 0.0); for (size_t i = 0; i < ns; ++i) for (size_t j = 0; j < kN; ++j) gm[l][j] += vecOf(sim[i], l)[j] / (double)ns; }
    std::vector<std::array<Vec, 3>> U(ns);
    for (size_t i = 0; i < ns; ++i) for (int l = 0; l < 3; ++l) { Vec v = vecOf(sim[i], l); for (size_t j = 0; j < kN; ++j) v[j] -= gm[l][j]; U[i][l] = unitVec(v); }
    std::vector<Vec> C(ns, Vec(ns, 0.0));
    {
      std::atomic<size_t> next{0};
      auto worker = [&]() { for (size_t i = next++; i < ns; i = next++) for (size_t j = i + 1; j < ns; ++j) { double s = 0; for (int l = 0; l < 3; ++l) s += dot(U[i][l], U[j][l]); C[i][j] = C[j][i] = s / 3.0; } };
      std::vector<std::thread> pool;
      for (int i = 0; i < threads; ++i) pool.emplace_back(worker);
      for (auto& th : pool) th.join();
    }
    auto sameMean = [&](const std::vector<size_t>& order) {
      double s = 0; size_t cnt = 0;
      for (size_t g = 0; g + (size_t)reps <= ns; g += reps) for (int a = 0; a < reps; ++a) for (int b = a + 1; b < reps; ++b) { s += C[order[g + a]][order[g + b]]; ++cnt; }
      return s / (double)cnt;
    };
    std::vector<size_t> id(ns); for (size_t i = 0; i < ns; ++i) id[i] = i;
    const double obsSame = sameMean(id);
    double allMean = 0; size_t allCnt = 0;
    for (size_t i = 0; i < ns; ++i) for (size_t j = i + 1; j < ns; ++j) { allMean += C[i][j]; ++allCnt; }
    allMean /= (double)allCnt;
    std::mt19937_64 g(20261106 + dom);
    std::vector<double> nulls;
    for (int p = 0; p < 2000; ++p) { std::shuffle(id.begin(), id.end(), g); nulls.push_back(sameMean(id)); }
    double nm = 0, nv = 0; size_t ge = 0;
    for (double v : nulls) { nm += v; if (v >= obsSame) ++ge; }
    nm /= (double)nulls.size();
    for (double v : nulls) nv += (v - nm) * (v - nm);
    const double nsd = std::sqrt(nv / (double)nulls.size());
    // nearest neighbour with the fingerprint mean of the centered simulations
    std::vector<std::array<Vec, 3>> F(K);
    for (int c = 0; c < K; ++c) for (int l = 0; l < 3; ++l) {
      Vec f(kN, 0.0);
      for (int r = 0; r < reps; ++r) { const Vec& v = vecOf(sim[(size_t)c * reps + r], l); for (size_t j = 0; j < kN; ++j) f[j] += (v[j] - gm[l][j]) / reps; }
      F[c][l] = unitVec(f);
    }
    std::vector<Vec> nn(tgt.size(), Vec(K, 0.0));
    for (size_t t = 0; t < tgt.size(); ++t) for (int l = 0; l < 3; ++l) {
      Vec v = vecOf(tgt[t], l); for (size_t j = 0; j < kN; ++j) v[j] -= gm[l][j];
      const Vec vu = unitVec(v);
      for (int c = 0; c < K; ++c) nn[t][c] += sq * dot(vu, F[c][l]);
    }
    nnOut[dom] = nn;
    std::printf("%s\"%s\":%s\"obsSame\":%.6f,\"allPairsMean\":%.6f,\"nullMean\":%.6f,\"nullSd\":%.6f,\"p\":%.5f,\"pairs\":%zu%s", dom ? "," : "", names[dom], "{", obsSame, allMean, nm, nsd, (1.0 + ge) / 2001.0, allCnt, "}");
  }
  std::printf("},\n\"nn\":%s\"coef\":", "{"); printMatrix(nnOut[0]); std::printf(",\"slot\":"); printMatrix(nnOut[1]); std::printf("},\n");
  // E5: the operand of candidate 0 queried repeatedly; the first N responses averaged, A's known part removed, matched filter.
  std::printf("\"e5\":[");
  {
    const size_t Ns[6] = {1, 5, 25, 50, 100, 200};
    bool firstN = true;
    for (size_t N : Ns) {
      if (N > rep.size()) continue;
      double zs[64] = {0};
      for (int l = 0; l < 3; ++l) {
        Vec avg(kN, 0.0);
        for (size_t i = 0; i < N; ++i) for (size_t j = 0; j < kN; ++j) avg[j] += rep[i].w[l][j] / (double)N;
        for (size_t j = 0; j < kN; ++j) avg[j] -= aKnown[l][j];
        const Vec au = unitVec(avg);
        for (int c = 0; c < K; ++c) zs[c] += sq * dot(au, Su[c][l]);
      }
      std::printf("%s{\"N\":%zu,\"z\":[", firstN ? "" : ",", N);
      for (int c = 0; c < K; ++c) std::printf("%s%.3f", c ? "," : "", zs[c]);
      std::printf("]}");
      firstN = false;
    }
  }
  std::printf("],\n");
  std::printf("\"done\":true}%s\n", "");
}

}  // namespace

int main(int argc, char** argv) {
  int threads = 12, seed4 = 1600, dictReps = 5, targets = 200, repeat = 200, exactDumps = 2, small = 0;
  for (int i = 1; i + 1 < argc; i += 2) {
    const std::string k = argv[i]; const int v = std::atoi(argv[i + 1]);
    if (k == "--seed4") seed4 = v; else if (k == "--dict-reps") dictReps = v; else if (k == "--targets") targets = v;
    else if (k == "--repeat") repeat = v; else if (k == "--exact-dumps") exactDumps = v; else if (k == "--small") small = v; else if (k == "--threads") threads = v;
    else { std::fprintf(stderr, "unknown option %s\n", k.c_str()); return 2; }
  }
  const size_t steps = 86400, blocks = (steps + kN - 1) / kN;  // 11
  const double rprime = std::sqrt(std::pow(5000.0, 2) + std::pow(15500.0 / 2, 2));
  const int64_t rprime2 = (int64_t)std::ceil(rprime * rprime);
  const double sNoise = 1250.0;
  Params P;
  P.noiseS = (int64_t)std::ceil(2 * rprime * sNoise + sNoise * sNoise);
  P.raised2 = (int64_t)std::ceil((rprime + sNoise) * (rprime + sNoise));
  P.beta = (double)P.noiseS / 4;
  (void)rprime2;

  // A: fixed-seed test key; B holds the public and relinearization keys only.
  uint8_t seed[32];
  for (int i = 0; i < 32; ++i) seed[i] = (uint8_t)(0x4e + 7 * i);
  HEContext A = HEContext::CreateClientSeeded(seed, sizeof seed, kN);
  if (!A.IsValid()) { std::fprintf(stderr, "context refused\n"); return 3; }
  const Bytes pk = A.GetPublicKey(), rk = A.GetRelinKeys();
  HEContext B = HEContext::CreateServer(pk.data(), pk.size());
  B.SetRelinKeys(rk.data(), rk.size());
  if (B.HasSecretKey()) { std::fprintf(stderr, "responder holds a secret key\n"); return 3; }

  // A's orbit and encrypted blocks.
  const V3 nA = unit({0.0, -std::sin(98 * kPi / 180), std::cos(98 * kPi / 180)});
  const double rA = 7078.137;
  const V3 c0 = unit(cross(nA, {0, 0, 1}));
  const Orbit Aorb = circular(rA, nA, c0, 0);
  const std::vector<P3> aTrack = sampleRange(Aorb, 0, steps);
  std::vector<std::vector<Bytes>> aBlocks(blocks, std::vector<Bytes>(3));
  for (size_t w = 0; w < blocks; ++w) for (int k = 0; k < 3; ++k) {
    std::vector<int64_t> v(kN, 0);
    for (size_t j = 0; j < kN && w * kN + j < steps; ++j) v[j] = aTrack[w * kN + j][k];
    aBlocks[w][k] = encryptVec(A, v);
  }

  std::printf("{\n\"driver\":\"noise_channel\",\"seal\":\"4.1.1\",\"forkCommit\":\"55a0ca86\",\"rprimeM\":%.3f,\"raised2\":%lld,\"noiseS\":%lld,\"histBinsPerOctave\":16,\"rows\":[\n",
              rprime, (long long)P.raised2, (long long)P.noiseS);
  bool first = true;
  size_t total = 0, vmTotal = 0;
  Raw raws[2]; int rawCount = 0;
  // Jobs run on worker threads, each with its own contexts holding the same keys
  // (the seeded key), and print in job order.
  using Job = std::function<Row(HEContext&, const HEContext&)>;
  std::vector<Job> jobs;
  auto geometry = [&](std::mt19937_64& g, double loM, double hiM, bool inBlock3, size_t* blockOut, double* missOut) {
    std::uniform_real_distribution<double> uni(0, 1);
    const double span = (double)steps;
    const double tc = inBlock3 ? (3.0 + uni(g)) * kN : span * (0.1 + 0.8 * uni(g));
    const double angle = (20 + 140 * uni(g)) * kPi / 180;
    const double missM = loM + (hiM - loM) * uni(g);
    const V3 c = unit(Aorb.at(tc));
    const V3 dA = cross(nA, c);
    const V3 nB = add(mul(nA, std::cos(angle)), mul(dA, std::sin(angle)));
    *blockOut = (size_t)(tc / kN); *missOut = missM;
    return circular(rA + missM / 1e3, nB, c, tc);
  };

  if (!small) {
    // The record 19 pairs (seed 1): every block of the day, in time order.
    std::mt19937_64 rng(1);
    std::uniform_real_distribution<double> uni(0, 1);
    for (int q = 0; q < 8; ++q) {
      const double tc = (double)steps * (0.1 + 0.8 * uni(rng));
      const double angle = (20 + 140 * uni(rng)) * kPi / 180;
      const double miss = q + 1 == 8 ? 60.0 : 2.0;
      const V3 c = unit(Aorb.at(tc));
      const V3 dA = cross(nA, c);
      const V3 nB = add(mul(nA, std::cos(angle)), mul(dA, std::sin(angle)));
      const Orbit bo = circular(rA + miss, nB, c, tc);
      for (size_t w = 0; w < blocks; ++w) {
        const size_t e = std::min(steps, (w + 1) * kN);
        Raw* raw = (rawCount < exactDumps && q == 0 && w == 3) ? &raws[rawCount++] : nullptr;
        jobs.push_back([=, &aBlocks, &aTrack](HEContext& A_, const HEContext& B_) { return measure(A_, B_, aBlocks, nullptr, aTrack, sampleRange(bo, w * kN, e), w, q + 1, P, steps, "pair", q + 1, (int)w, rprime, raw); });
      }
    }
    // Breadth sets (seeds 2, 3) and the third set (seed 4).
    const struct { const char* name; uint64_t seed; int count; double lo, hi; uint64_t base; } sets[] = {
        {"g2", 2, 200, 0.5 * rprime, 2 * rprime, 1000}, {"g3", 3, 200, 0.0, 5000.0, 2000}, {"g4", 4, seed4, 0.0, 2 * rprime, 3000}};
    for (const auto& st : sets) {
      std::mt19937_64 g(st.seed);
      for (int k = 0; k < st.count; ++k) {
        size_t w; double miss;
        const Orbit bo = geometry(g, st.lo, st.hi, false, &w, &miss);
        const size_t e = std::min(steps, (w + 1) * kN);
        { const std::string nm = st.name; const uint64_t id = st.base + k; jobs.push_back([=, &aBlocks, &aTrack](HEContext& A_, const HEContext& B_) { return measure(A_, B_, aBlocks, nullptr, aTrack, sampleRange(bo, w * kN, e), w, id, P, steps, nm, k, 0, rprime, nullptr); }); }
      }
    }
  }
  // Dictionary arm: K = 64 candidates crossing A's track inside block 3 (seed 5).
  const int K = 64;
  std::vector<std::vector<P3>> cand(K);
  {
    std::mt19937_64 g(5);
    for (int c = 0; c < K; ++c) {
      size_t w; double miss;
      const Orbit bo = geometry(g, 0.0, 2 * rprime, true, &w, &miss);
      cand[c] = sampleRange(bo, 3 * kN, 4 * kN);
    }
  }
  std::vector<CoefOut> coefSim((size_t)K * dictReps), coefTgt(targets), coefRep(repeat);
  for (int c = 0; c < K; ++c) for (int r = 0; r < dictReps; ++r)
    jobs.push_back([=, &aBlocks, &aTrack, &cand, &coefSim, &coefTgt, &coefRep](HEContext& A_, const HEContext& B_) { return measure(A_, B_, aBlocks, nullptr, aTrack, cand[c], 3, 5000 + c, P, steps, "dictSim", c, r, rprime, nullptr, &coefSim[c * dictReps + r]); });
  for (int t = 0; t < targets; ++t) {
    const int c = t % K;
    jobs.push_back([=, &aBlocks, &aTrack, &cand, &coefSim, &coefTgt, &coefRep](HEContext& A_, const HEContext& B_) { return measure(A_, B_, aBlocks, nullptr, aTrack, cand[c], 3, 5000 + c, P, steps, "dictTgt", c, t, rprime, nullptr, &coefTgt[t]); });
  }
  // The same operands repeated: the fresh-encryption jitter alone (P2).
  for (int r = 0; r < repeat; ++r)
    jobs.push_back([=, &aBlocks, &aTrack, &cand, &coefSim, &coefTgt, &coefRep](HEContext& A_, const HEContext& B_) { return measure(A_, B_, aBlocks, nullptr, aTrack, cand[0], 3, 5000, P, steps, "repeat", 0, r, rprime, nullptr, &coefRep[r]); });
  {
    std::vector<Row> rowsOut(jobs.size());
    std::atomic<size_t> next{0};
    auto worker = [&]() {
      HEContext Aw = HEContext::CreateClientSeeded(seed, sizeof seed, kN);
      HEContext Bw = HEContext::CreateServer(pk.data(), pk.size());
      Bw.SetRelinKeys(rk.data(), rk.size());
      if (Bw.HasSecretKey()) { std::fprintf(stderr, "worker responder holds a secret key\n"); std::exit(3); }
      for (size_t i = next++; i < jobs.size(); i = next++) rowsOut[i] = jobs[i](Aw, Bw);
    };
    std::vector<std::thread> pool;
    for (int i = 0; i < threads; ++i) pool.emplace_back(worker);
    for (auto& th : pool) th.join();
    for (const Row& r : rowsOut) { printRow(r, first); first = false; ++total; vmTotal += r.valueMismatches; }
  }
  std::printf("\n],\n");

  // C1 matrix: share of steps of block 3 where candidate c is within a factor of 2 of target t's distance.
  std::printf("\"c1Matrix\":[");
  {
    std::vector<std::vector<double>> dist(K, std::vector<double>(kN));
    for (int c = 0; c < K; ++c) for (size_t j = 0; j < kN; ++j) {
      double q = 0;
      for (int k = 0; k < 3; ++k) { const double d = (double)(aTrack[3 * kN + j][k] - cand[c][j][k]); q += d * d; }
      dist[c][j] = std::max(std::sqrt(q), 1.0);
    }
    for (int t = 0; t < K; ++t) {
      std::printf("%s[", t ? "," : "");
      for (int c = 0; c < K; ++c) {
        size_t in = 0;
        for (size_t j = 0; j < kN; ++j) if (std::fabs(std::log2(dist[c][j] / dist[t][j])) <= 1.0) ++in;
        std::printf("%s%.6f", c ? "," : "", (double)in / kN);
      }
      std::printf("]");
    }
  }
  std::printf("],\n");

  // P1: slot-constant operands, the S2 pipeline on one block, |c_a - c_b| from 0 to 2^23.
  std::printf("\"p1\":[");
  {
    const int64_t ca = 1000000;
    const int64_t deltas[] = {0, 1, 16, 256, 4096, 65536, 1048576, 8388608};
    std::vector<Bytes> ablock(3);
    for (int k = 0; k < 3; ++k) ablock[k] = encryptVec(A, std::vector<int64_t>(kN, ca));
    bool f2 = true;
    for (int64_t delta : deltas) {
      std::vector<P3> bp(kN, P3{ca - delta, ca - delta, ca - delta});
      Response R = respond(B, ablock, bp, 0, 9000, P, kN);
      double r[kReadingLen]; int sb = 0;
      readNoise(A, R.ct, r, nullptr, nullptr, &sb);
      std::vector<WideInt> dec = A.DecryptWideVector(R.ct.data(), R.ct.size());
      size_t vm = 0;
      for (size_t j = 0; j < kN; ++j) {
        const i128 d2 = (i128)3 * delta * delta;
        if (wideToI128(dec[j]) - wideToI128(R.rho[j]) != d2 - P.raised2 + R.eta[j]) ++vm;
      }
      std::printf("%s{\"delta\":%lld,\"valueMismatches\":%zu,\"reading\":[", f2 ? "" : ",", (long long)delta, vm);
      for (int i = 0; i < kReadingLen; ++i) std::printf("%s%.4f", i ? "," : "", r[i]);
      std::printf("]}");
      f2 = false;
    }
  }
  std::printf("],\n");

  coefAnalysis(A, aBlocks, cand, coefSim, coefTgt, coefRep, K, dictReps, threads);
  std::printf(",\n");

  // Exact residues for the E2E's big-integer check of the long double reading.
  std::printf("\"exact\":[");
  for (int i = 0; i < rawCount; ++i) {
    std::printf("%s{\"limbs\":%zu,\"n\":%u,\"q\":[", i ? "," : "", raws[i].limbsLane0.size() / kN, kN);
    {
      auto cd = A.impl_->lanes_[0].context->first_context_data();
      const auto& q = cd->parms().coeff_modulus();
      for (size_t j = 0; j < q.size(); ++j) std::printf("%s\"%llu\"", j ? "," : "", (unsigned long long)q[j].value());
      std::printf("],\"t\":\"%llu\",\"d\":[", (unsigned long long)cd->parms().plain_modulus().value());
    }
    // residues are stored per coefficient i, limb j consecutively
    for (size_t x = 0; x < raws[i].limbsLane0.size(); ++x) std::printf("%s\"%llu\"", x ? "," : "", (unsigned long long)raws[i].limbsLane0[x]);
    std::printf("]}");
  }
  std::printf("],\n\"rowsTotal\":%zu,\"valueMismatches\":%zu,\"responderHasSecretKey\":false}\n", total, vmTotal);
  return vmTotal == 0 ? 0 : 1;
}
