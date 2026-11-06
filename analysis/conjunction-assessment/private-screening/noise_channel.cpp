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
#include <chrono>
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
            double rprime, Raw* raw) {
  Row row; row.set = set; row.id = id; row.rep = rep; row.w = (int)w;
  Response R = respond(B, aBlocks[w], bBlock, w, objectId, P, totalSteps);
  readNoise(A, R.ct, row.reading, raw, nullptr, &row.sealBudgetFromD);
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

}  // namespace

int main(int argc, char** argv) {
  int seed4 = 1600, dictReps = 5, targets = 200, repeat = 30, exactDumps = 2, small = 0;
  for (int i = 1; i + 1 < argc; i += 2) {
    const std::string k = argv[i]; const int v = std::atoi(argv[i + 1]);
    if (k == "--seed4") seed4 = v; else if (k == "--dict-reps") dictReps = v; else if (k == "--targets") targets = v;
    else if (k == "--repeat") repeat = v; else if (k == "--exact-dumps") exactDumps = v; else if (k == "--small") small = v;
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

  std::printf("{\"driver\":\"noise_channel\",\"seal\":\"4.1.1\",\"forkCommit\":\"55a0ca86\",\"rprimeM\":%.3f,\"raised2\":%lld,\"noiseS\":%lld,\"histBinsPerOctave\":16,\"rows\":[\n",
              rprime, (long long)P.raised2, (long long)P.noiseS);
  bool first = true;
  size_t total = 0, vmTotal = 0;
  Raw raws[2]; int rawCount = 0;
  auto emit = [&](Row r) { printRow(r, first); first = false; ++total; vmTotal += r.valueMismatches; };
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
        emit(measure(A, B, aBlocks, nullptr, aTrack, sampleRange(bo, w * kN, e), w, q + 1, P, steps, "pair", q + 1, (int)w, rprime, raw));
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
        emit(measure(A, B, aBlocks, nullptr, aTrack, sampleRange(bo, w * kN, e), w, st.base + k, P, steps, st.name, k, 0, rprime, nullptr));
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
  for (int c = 0; c < K; ++c) for (int r = 0; r < dictReps; ++r)
    emit(measure(A, B, aBlocks, nullptr, aTrack, cand[c], 3, 5000 + c, P, steps, "dictSim", c, r, rprime, nullptr));
  for (int t = 0; t < targets; ++t) {
    const int c = t % K;
    emit(measure(A, B, aBlocks, nullptr, aTrack, cand[c], 3, 5000 + c, P, steps, "dictTgt", c, t, rprime, nullptr));
  }
  // The same operands repeated: the fresh-encryption jitter alone (P2).
  for (int r = 0; r < repeat; ++r)
    emit(measure(A, B, aBlocks, nullptr, aTrack, cand[0], 3, 5000, P, steps, "repeat", 0, r, rprime, nullptr));
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
