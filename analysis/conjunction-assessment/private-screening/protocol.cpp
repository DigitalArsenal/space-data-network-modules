// The private screening protocol (PROTOCOL-19.md) on the FlatBuffers fork's
// homomorphic batching API: the requester A encrypts its sampled trajectory
// under its own key; the responder B, holding only A's public and
// relinearization keys, encrypts its own operands under that key and computes
// the masked squared distance (S1 tube check, S2 screening, n 8192, depth 1)
// and the anchor-free physics check (S3, n 16384, depth 3) ciphertext by
// ciphertext; A decrypts the masked values. The two-party comparison S4 is not
// built: the decision is evaluated by an oracle holding B's masks and A's
// decryptions, and every decrypted value is checked exactly against the
// plaintext big integer. The driver prints one JSON document with the
// known-answer rows and the per-step costs; the E2Es in ../tests read it.
//
//   private_screening_protocol [--days 1] [--pairs 8] [--seed 1]
//                              [--threshold-km 5] [--vmax-kms 15.5]
//                              [--noise-km 1.25] [--stride-s 60]
// Trajectories: synthetic circular two-body orbits (the bench's set), a
// test-only oracle; the costs do not depend on them.
#include <algorithm>
#include <array>
#include <atomic>
#include <thread>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <random>
#include <string>
#include <vector>

#include "flatbuffers/he_encryption.h"

using namespace flatbuffers::he;
using Clock = std::chrono::steady_clock;
using Bytes = std::vector<uint8_t>;

namespace {

constexpr double kMuKm = 398600.4418;          // km^3/s^2
constexpr int64_t kMuM = 398600441800000LL;    // m^3/s^2, exact
constexpr double kPi = 3.14159265358979323846;
constexpr uint32_t kN1 = 8192, kN3 = 16384;
constexpr uint32_t kCoordBound = 24;           // |coordinate| < 2^24 m
constexpr uint32_t kMaskBound = 120;           // rho in [2^100, 2^119)
constexpr int kTolLog2 = 8;                    // direction tolerance 1/256
constexpr int kTolELog2 = 7;                   // magnitude tolerance 1/128 (J2 band, PROTOCOL-19 2b)

double ms(Clock::time_point a, Clock::time_point b) {
  return std::chrono::duration<double, std::milli>(b - a).count();
}

// ---- 256-bit signed integer (sign + magnitude), the plaintext oracle ----
struct Big {
  bool neg = false;
  std::array<uint64_t, 4> m{};
  static Big From(int64_t v) {
    Big b;
    b.neg = v < 0;
    b.m[0] = v < 0 ? (uint64_t)(-(v + 1)) + 1 : (uint64_t)v;
    return b;
  }
  static Big FromWide(const WideInt& w) {
    Big b;
    b.neg = w.negative;
    for (int i = 0; i < 3; ++i) b.m[i] = w.magnitude[i];
    if (b.IsZero()) b.neg = false;
    return b;
  }
  bool IsZero() const { return !m[0] && !m[1] && !m[2] && !m[3]; }
  static int CmpMag(const Big& a, const Big& b) {
    for (int i = 3; i >= 0; --i) if (a.m[i] != b.m[i]) return a.m[i] < b.m[i] ? -1 : 1;
    return 0;
  }
  static Big AddMag(const Big& a, const Big& b) {
    Big r; unsigned __int128 c = 0;
    for (int i = 0; i < 4; ++i) { c += (unsigned __int128)a.m[i] + b.m[i]; r.m[i] = (uint64_t)c; c >>= 64; }
    return r;
  }
  static Big SubMag(const Big& a, const Big& b) {  // |a| >= |b|
    Big r; __int128 c = 0;
    for (int i = 0; i < 4; ++i) { c += (__int128)a.m[i] - b.m[i]; r.m[i] = (uint64_t)c; c = c < 0 ? -1 : 0; }
    return r;
  }
  Big operator-() const { Big r = *this; if (!r.IsZero()) r.neg = !neg; return r; }
  Big operator+(const Big& o) const {
    Big r;
    if (neg == o.neg) { r = AddMag(*this, o); r.neg = neg; }
    else if (CmpMag(*this, o) >= 0) { r = SubMag(*this, o); r.neg = neg; }
    else { r = SubMag(o, *this); r.neg = o.neg; }
    if (r.IsZero()) r.neg = false;
    return r;
  }
  Big operator-(const Big& o) const { return *this + (-o); }
  Big operator*(const Big& o) const {
    Big r;
    for (int i = 0; i < 4; ++i) {
      unsigned __int128 c = 0;
      for (int j = 0; i + j < 4; ++j) {
        c += (unsigned __int128)m[i] * o.m[j] + r.m[i + j];
        r.m[i + j] = (uint64_t)c; c >>= 64;
      }
    }
    r.neg = neg != o.neg && !r.IsZero();
    return r;
  }
  bool operator==(const Big& o) const { return neg == o.neg && m == o.m; }
  bool operator<(const Big& o) const {
    if (neg != o.neg) return neg;
    const int c = CmpMag(*this, o);
    return neg ? c > 0 : c < 0;
  }
  bool operator<=(const Big& o) const { return *this < o || *this == o; }
  WideInt ToWide() const {
    WideInt w; w.negative = neg;
    for (int i = 0; i < 3; ++i) w.magnitude[i] = m[i];
    return w;
  }
  std::string Str() const {  // decimal
    Big v = *this; v.neg = false;
    std::string s;
    if (v.IsZero()) return "0";
    while (!v.IsZero()) {
      unsigned __int128 rem = 0;
      for (int i = 3; i >= 0; --i) {
        const unsigned __int128 cur = (rem << 64) | v.m[i];
        v.m[i] = (uint64_t)(cur / 10); rem = cur % 10;
      }
      s.push_back((char)('0' + (int)rem));
    }
    if (neg) s.push_back('-');
    std::reverse(s.begin(), s.end());
    return s;
  }
  Big Abs() const { Big r = *this; r.neg = false; return r; }
};
Big Shl(const Big& a, int k) {  // a * 2^k, k < 64
  Big r; unsigned __int128 c = 0;
  for (int i = 0; i < 4; ++i) { c |= (unsigned __int128)a.m[i] << k; r.m[i] = (uint64_t)c; c >>= 64; }
  r.neg = a.neg; return r;
}
Big Shr(const Big& a, int k) {  // truncated |a| / 2^k, k < 64
  Big r; uint64_t carry = 0;
  for (int i = 3; i >= 0; --i) { r.m[i] = (a.m[i] >> k) | carry; carry = k ? a.m[i] << (64 - k) : 0; }
  r.neg = a.neg && !r.IsZero(); return r;
}

// ---- orbits (test-only oracle) ----
struct V3 { double x, y, z; };
V3 add(V3 a, V3 b) { return {a.x + b.x, a.y + b.y, a.z + b.z}; }
V3 mul(V3 a, double s) { return {a.x * s, a.y * s, a.z * s}; }
V3 cross(V3 a, V3 b) { return {a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x}; }
V3 unit(V3 a) { return mul(a, 1.0 / std::sqrt(a.x * a.x + a.y * a.y + a.z * a.z)); }

struct Track {  // positions in integer metres on the 1 s grid
  std::string name;
  std::vector<std::array<int64_t, 3>> p;
};
struct Orbit {
  double r, n; V3 c, d; double tc;
  V3 at(double t) const { const double u = n * (t - tc); return add(mul(c, r * std::cos(u)), mul(d, r * std::sin(u))); }
};
Orbit circular(double r, V3 normal, V3 c, double tc, double rate = 1.0) {
  normal = unit(normal);
  return {r, rate * std::sqrt(kMuKm / (r * r * r)), c, cross(normal, c), tc};
}
Track sample(const std::string& name, const Orbit& o, size_t steps) {
  Track t; t.name = name; t.p.resize(steps);
  for (size_t j = 0; j < steps; ++j) {
    const V3 q = o.at((double)j);
    t.p[j] = {std::llround(q.x * 1e3), std::llround(q.y * 1e3), std::llround(q.z * 1e3)};
  }
  return t;
}

// ---- the protocol over the fork API ----
struct Counters {
  size_t ctxCtMultiplies = 0;
  double aEncryptMs = 0, aUploadBytes = 0;
};
struct Ops {  // B's side: every operation is counted; multiplies are the only ct x ct
  const HEContext& ctx; size_t& multiplies;
  Bytes Mul(const Bytes& a, const Bytes& b) { ++multiplies; Bytes r = ctx.Multiply(a, b); Check(r, "Multiply"); return r; }
  Bytes Add(const Bytes& a, const Bytes& b) { Bytes r = ctx.Add(a, b); Check(r, "Add"); return r; }
  Bytes Sub(const Bytes& a, const Bytes& b) { Bytes r = ctx.Sub(a.data(), a.size(), b.data(), b.size()); Check(r, "Sub"); return r; }
  Bytes MulPlain(const Bytes& a, int64_t p) { Bytes r = ctx.MultiplyPlain(a.data(), a.size(), p); Check(r, "MultiplyPlain"); return r; }
  Bytes SubPlain(const Bytes& a, int64_t p) { Bytes r = ctx.SubPlain(a.data(), a.size(), p); Check(r, "SubPlain"); return r; }
  Bytes EncI(const std::vector<int64_t>& v, uint32_t bound) { Bytes r = ctx.EncryptInt64Vector(v, bound); Check(r, "EncryptInt64Vector"); return r; }
  Bytes EncW(const std::vector<WideInt>& v, uint32_t bound) { Bytes r = ctx.EncryptWideVector(v, bound); Check(r, "EncryptWideVector"); return r; }
  void Check(const Bytes& r, const char* what) {
    if (r.empty()) { std::fprintf(stderr, "%s refused: %s\n", what, ctx.LastError().message.c_str()); std::exit(3); }
  }
};

std::vector<WideInt> wideVec(const std::vector<Big>& v) {
  std::vector<WideInt> w(v.size());
  for (size_t i = 0; i < v.size(); ++i) w[i] = v[i].ToWide();
  return w;
}

struct Rng {
  std::mt19937_64 g;
  explicit Rng(uint64_t seed) : g(seed) {}
  Big Mask() {  // uniform in [2^100, 2^119)
    Big b; b.m[0] = g(); b.m[1] = g() & ((1ULL << 55) - 1); b.m[1] |= 1ULL << 36;  // bit 100 set, below 2^119
    return b;
  }
};

// A's submission at n: one ciphertext per coordinate per block, for the block
// of steps [w n, (w+1) n), with a slot offset into the track (the shifted copies).
Bytes encryptBlock(const HEContext& a, const Track& t, size_t w, uint32_t n, int k, long shift, Counters& c) {
  std::vector<int64_t> v(n, 0);
  for (size_t j = 0; j < n; ++j) {
    const long s = (long)(w * n + j) + shift;
    if (s >= 0 && (size_t)s < t.p.size()) v[j] = t.p[(size_t)s][k];
  }
  const auto s0 = Clock::now();
  Bytes ct = a.EncryptInt64Vector(v, kCoordBound);
  c.aEncryptMs += ms(s0, Clock::now());
  if (ct.empty()) { std::fprintf(stderr, "A encrypt refused: %s\n", a.LastError().message.c_str()); std::exit(3); }
  c.aUploadBytes += (double)ct.size();
  return ct;
}

struct DistanceResult {  // S1/S2 on one pair, all blocks
  size_t alertSteps = 0, plainAlertSteps = 0, signMismatches = 0, valueMismatches = 0, missed = 0, extra = 0;
  double maxExtraDistanceM = 0; long firstFail = -1, firstNonAlert = -1;
  std::vector<size_t> alertList, plainAlertList;
  double bComputeMs = 0, bResponseBytes = 0, aDecryptMs = 0;
  int minNoiseBudget = 1 << 30;
  std::vector<Big> values;  // the plaintext |a-b|^2 - R'^2 per step (for the leakage study)
  // A's view: every decrypted slot of the first block (the reconstruction attempt).
  std::vector<Big> aView; std::vector<double> trueDistanceM;
};

// S1 and S2: masked |a - b|^2 - thr^2 (+ eta) per step. B's operands (b_k, mask,
// noise) are encrypted under A's key by B. Decision: value < 0.
DistanceResult maskedDistance(const HEContext& aCtx, const HEContext& bCtx, const std::vector<std::vector<Bytes>>& aBlocks,
                              const Track& a, const Track& b, int64_t thr2, int64_t raisedThr2, int64_t noiseS, double beta,
                              size_t steps, Rng& rng, Counters& c, bool keepValues,
                              size_t wStart = 0, size_t wEnd = (size_t)-1) {
  DistanceResult r;
  Ops B{bCtx, c.ctxCtMultiplies};
  const size_t blocks = std::min(aBlocks.size(), wEnd);
  const Big thrBig = Big::From(raisedThr2);
  std::mt19937_64 noiseGen(rng.g());
  for (size_t w = wStart; w < blocks; ++w) {
    // B: its own coordinates, the mask and the noise, under A's key.
    auto s0 = Clock::now();
    std::vector<int64_t> bk[3] = {std::vector<int64_t>(kN1, 0), std::vector<int64_t>(kN1, 0), std::vector<int64_t>(kN1, 0)};
    std::vector<int64_t> eta(kN1, 0);
    std::vector<Big> rho(kN1);
    for (size_t j = 0; j < kN1; ++j) {
      const size_t s = w * kN1 + j;
      if (s < b.p.size()) for (int k = 0; k < 3; ++k) bk[k][j] = b.p[s][k];
      rho[j] = rng.Mask();
      if (noiseS > 0) {
        std::uniform_real_distribution<double> u(-0.5, 0.5);
        const double x = u(noiseGen);
        double lap = -beta * (x < 0 ? -1.0 : 1.0) * std::log(1 - 2 * std::fabs(x));
        lap = std::max(-(double)noiseS, std::min((double)noiseS, lap));
        eta[j] = std::llround(lap);
      }
    }
    Bytes eb[3];
    for (int k = 0; k < 3; ++k) eb[k] = B.EncI(bk[k], kCoordBound);
    Bytes emask = B.EncW(wideVec(rho), kMaskBound);
    // B squares the differences itself: (Enc(a_k) - Enc(b_k))^2, one ct x ct per coordinate.
    Bytes acc;
    for (int k = 0; k < 3; ++k) {
      Bytes d = B.Sub(aBlocks[w][k], eb[k]);
      Bytes sq = B.Mul(d, d);
      acc = k ? B.Add(acc, sq) : sq;
    }
    acc = B.SubPlain(acc, thr2 == raisedThr2 ? thr2 : raisedThr2);
    if (noiseS > 0) acc = B.Add(acc, B.EncI(eta, 26));
    Bytes response = B.Add(acc, emask);
    r.bComputeMs += ms(s0, Clock::now());
    r.bResponseBytes += (double)response.size();
    // A decrypts the masked values.
    s0 = Clock::now();
    r.minNoiseBudget = std::min(r.minNoiseBudget, aCtx.NoiseBudget(response.data(), response.size()));
    std::vector<WideInt> dec = aCtx.DecryptWideVector(response.data(), response.size());
    r.aDecryptMs += ms(s0, Clock::now());
    // Oracle: value = decrypted - rho (S4 not built); plaintext check.
    for (size_t j = 0; j < kN1; ++j) {
      const size_t s = w * kN1 + j;
      if (s >= steps) break;
      Big d2;
      for (int k = 0; k < 3; ++k) { const Big dk = Big::From(a.p[s][k] - b.p[s][k]); d2 = d2 + dk * dk; }
      const Big value = d2 - thrBig + Big::From(eta[j]);
      const Big decrypted = Big::FromWide(dec[j]) - rho[j];
      if (!(decrypted == value)) { ++r.valueMismatches; if (r.firstFail < 0) r.firstFail = (long)s; }
      const bool alert = decrypted < Big();
      const bool plainAlert = d2 < Big::From(thr2);  // the un-noised plaintext decision at thr
      if (noiseS == 0) {
        if (alert != plainAlert) ++r.signMismatches;
      } else {
        if (plainAlert && !alert) ++r.missed;
        if (alert && !plainAlert) { ++r.extra; r.maxExtraDistanceM = std::max(r.maxExtraDistanceM, std::sqrt(d2.Abs().m[0] * 1.0)); }
      }
      if (alert) { ++r.alertSteps; if (r.alertList.size() < 64) r.alertList.push_back(s); }
      else if (r.firstNonAlert < 0) r.firstNonAlert = (long)s;
      if (plainAlert) { ++r.plainAlertSteps; if (r.plainAlertList.size() < 64) r.plainAlertList.push_back(s); }
      if (keepValues) r.values.push_back(d2 - Big::From(thr2));
      if (keepValues && w == wStart) { r.aView.push_back(Big::FromWide(dec[j])); r.trueDistanceM.push_back(std::sqrt((double)d2.m[0] + 18446744073709551616.0 * (double)d2.m[1])); }
    }
  }
  return r;
}

struct PhysicsResult {
  size_t stepsChecked = 0, passSteps = 0, failSteps = 0, mismatches = 0; long firstFail = -1;
  double bComputeMs = 0, bResponseBytes = 0, aDecryptMs = 0; int minNoiseBudget = 1 << 30;
  std::string sampleE, sampleF, sampleEPlain, sampleFPlain;
};

// S3: the anchor-free physics check at n 16384, depth 3. A submits three
// slot-aligned copies a(t - D), a(t), a(t + D); B computes d2 and the two
// two-body identities, masked.
PhysicsResult physicsCheck(const HEContext& aCtx, const HEContext& bCtx, const Track& t, long stride, size_t steps, Rng& rng, Counters& c) {
  PhysicsResult r;
  Ops B{bCtx, c.ctxCtMultiplies};
  const size_t blocks = (steps + kN3 - 1) / kN3;
  const Big mu = Big::From(kMuM);
  const Big D2 = Big::From(stride * stride);
  const Big muD4 = mu * mu * D2 * D2;              // mu^2 D^4
  const Big tol = Shr(muD4, kTolELog2);            // mu^2 D^4 / 128
  std::vector<Big> constVec(kN3, muD4);
  for (size_t w = 0; w < blocks; ++w) {
    // A's three copies per coordinate.
    Bytes am[3], a0[3], ap[3];
    for (int k = 0; k < 3; ++k) {
      am[k] = encryptBlock(aCtx, t, w, kN3, k, -stride, c);
      a0[k] = encryptBlock(aCtx, t, w, kN3, k, 0, c);
      ap[k] = encryptBlock(aCtx, t, w, kN3, k, stride, c);
    }
    auto s0 = Clock::now();
    std::vector<Big> rhoE(kN3), rhoF(kN3);
    for (size_t j = 0; j < kN3; ++j) { rhoE[j] = rng.Mask(); rhoF[j] = rng.Mask(); }
    Bytes eConst = B.EncW(wideVec(constVec), 122);
    Bytes eRhoE = B.EncW(wideVec(rhoE), kMaskBound), eRhoF = B.EncW(wideVec(rhoF), kMaskBound);
    Bytes d2[3], a2, dot, dd;
    for (int k = 0; k < 3; ++k) d2[k] = B.Sub(B.Add(am[k], ap[k]), B.MulPlain(a0[k], 2));
    for (int k = 0; k < 3; ++k) { Bytes s = B.Mul(a0[k], a0[k]); a2 = k ? B.Add(a2, s) : s; }
    for (int k = 0; k < 3; ++k) { Bytes s = B.Mul(a0[k], d2[k]); dot = k ? B.Add(dot, s) : s; }
    for (int k = 0; k < 3; ++k) { Bytes s = B.Mul(d2[k], d2[k]); dd = k ? B.Add(dd, s) : s; }
    Bytes E = B.Sub(B.Mul(B.Mul(dot, dot), a2), eConst);
    Bytes cr[3];
    for (int k = 0; k < 3; ++k) {
      const int i = (k + 1) % 3, j = (k + 2) % 3;
      cr[k] = B.Sub(B.Mul(a0[i], d2[j]), B.Mul(a0[j], d2[i]));
    }
    Bytes c2;
    for (int k = 0; k < 3; ++k) { Bytes s = B.Mul(cr[k], cr[k]); c2 = k ? B.Add(c2, s) : s; }
    Bytes F = B.Sub(B.MulPlain(c2, 1LL << (2 * kTolLog2)), B.Mul(a2, dd));
    Bytes respE = B.Add(E, eRhoE), respF = B.Add(F, eRhoF);
    r.bComputeMs += ms(s0, Clock::now());
    r.bResponseBytes += (double)(respE.size() + respF.size());
    s0 = Clock::now();
    r.minNoiseBudget = std::min({r.minNoiseBudget, aCtx.NoiseBudget(respE.data(), respE.size()), aCtx.NoiseBudget(respF.data(), respF.size())});
    std::vector<WideInt> decE = aCtx.DecryptWideVector(respE.data(), respE.size());
    std::vector<WideInt> decF = aCtx.DecryptWideVector(respF.data(), respF.size());
    r.aDecryptMs += ms(s0, Clock::now());
    for (size_t j = 0; j < kN3; ++j) {
      const long s = (long)(w * kN3 + j);
      if ((size_t)s >= steps) break;
      if (s - stride < 0 || (size_t)(s + stride) >= steps) continue;  // no neighbour: not checked
      Big A[3], Dd[3];
      for (int k = 0; k < 3; ++k) {
        A[k] = Big::From(t.p[(size_t)s][k]);
        Dd[k] = Big::From(t.p[(size_t)(s - stride)][k] + t.p[(size_t)(s + stride)][k] - 2 * t.p[(size_t)s][k]);
      }
      Big pa2, pdot, pdd, pc2;
      for (int k = 0; k < 3; ++k) { pa2 = pa2 + A[k] * A[k]; pdot = pdot + A[k] * Dd[k]; pdd = pdd + Dd[k] * Dd[k]; }
      for (int k = 0; k < 3; ++k) {
        const int i = (k + 1) % 3, jj = (k + 2) % 3;
        const Big ck = A[i] * Dd[jj] - A[jj] * Dd[i];
        pc2 = pc2 + ck * ck;
      }
      const Big pE = pdot * pdot * pa2 - muD4;
      const Big pF = Shl(pc2, 2 * kTolLog2) - pa2 * pdd;
      const Big dE = Big::FromWide(decE[j]) - rhoE[j], dF = Big::FromWide(decF[j]) - rhoF[j];
      ++r.stepsChecked;
      if (!(dE == pE) || !(dF == pF)) ++r.mismatches;
      const bool pass = dE.Abs() <= tol && dF <= Big();
      if (pass) ++r.passSteps; else { ++r.failSteps; if (r.firstFail < 0) r.firstFail = s; }
      if (r.sampleE.empty()) { r.sampleE = dE.Str(); r.sampleF = dF.Str(); r.sampleEPlain = pE.Str(); r.sampleFPlain = pF.Str(); }
    }
  }
  return r;
}

std::string list(const std::vector<size_t>& v) {
  std::string s = "[";
  for (size_t i = 0; i < v.size(); ++i) s += (i ? "," : "") + std::to_string(v[i]);
  return s + "]";
}

struct Args { double days = 1, thresholdKm = 5, vmax = 15.5, noiseKm = 1.25; int pairs = 8; uint64_t seed = 1; long stride = 60; int threads = 1; };

}  // namespace

int main(int argc, char** argv) {
  Args a;
  for (int i = 1; i + 1 < argc; i += 2) {
    const std::string k = argv[i]; const double v = std::atof(argv[i + 1]);
    if (k == "--days") a.days = v; else if (k == "--pairs") a.pairs = (int)v; else if (k == "--seed") a.seed = (uint64_t)v;
    else if (k == "--threshold-km") a.thresholdKm = v; else if (k == "--vmax-kms") a.vmax = v;
    else if (k == "--noise-km") a.noiseKm = v; else if (k == "--stride-s") a.stride = (long)v; else if (k == "--threads") a.threads = (int)v;
    else { std::fprintf(stderr, "unknown option %s\n", k.c_str()); return 2; }
  }
  const size_t steps = (size_t)std::llround(a.days * 86400.0);
  const size_t blocks1 = (steps + kN1 - 1) / kN1;
  const double rprime = std::sqrt(std::pow(a.thresholdKm * 1e3, 2) + std::pow(a.vmax * 1e3 / 2, 2));
  const int64_t rprime2 = (int64_t)std::ceil(rprime * rprime);
  const double sNoise = a.noiseKm * 1e3;
  const int64_t noiseS = (int64_t)std::ceil(2 * rprime * sNoise + sNoise * sNoise);
  const int64_t raised2 = (int64_t)std::ceil((rprime + sNoise) * (rprime + sNoise));
  const int64_t d0 = 1000, d02 = d0 * d0;

  // Trajectories: the bench's set (seed 1).
  std::mt19937_64 rng(a.seed);
  const V3 nA = unit({0.0, -std::sin(98 * kPi / 180), std::cos(98 * kPi / 180)});
  const double rA = 7078.137;
  std::uniform_real_distribution<double> uni(0, 1);
  V3 c0 = unit(cross(nA, {0, 0, 1}));
  const Orbit A = circular(rA, nA, c0, 0);
  struct PairDef { Orbit b; double tc, missKm; };
  std::vector<PairDef> pairs;
  const double span = (double)steps;
  for (int k = 0; k < a.pairs; ++k) {
    const double tc = span * (0.1 + 0.8 * uni(rng));
    const double angle = (20 + 140 * uni(rng)) * kPi / 180;
    const double miss = k + 1 == a.pairs ? 60.0 : 2.0;
    const V3 c = unit(A.at(tc));
    const V3 dA = cross(nA, c);
    const V3 nB = add(mul(nA, std::cos(angle)), mul(dA, std::sin(angle)));
    pairs.push_back({circular(rA + miss, nB, c, tc), tc, miss});
  }
  const Track trackA = sample("A", A, steps);
  std::vector<Track> trackB;
  for (size_t q = 0; q < pairs.size(); ++q) trackB.push_back(sample("B" + std::to_string(q + 1), pairs[q].b, steps));
  Track declared = trackA; declared.name = "A declared public track (+100 m x)";
  for (auto& p : declared.p) p[0] += 100;
  // The constant-velocity segment: A's track, then from step 3600 a straight
  // line at A's velocity for 600 s, then A's track again.
  Track line = trackA; line.name = "constant-velocity segment at steps 3600-4199";
  { const V3 p0 = A.at(3600), p1 = A.at(3601); const V3 v = add(p1, mul(p0, -1));
    for (size_t j = 3600; j < std::min(steps, (size_t)4200); ++j) { const V3 q = add(p0, mul(v, (double)(j - 3600))); line.p[j] = {std::llround(q.x * 1e3), std::llround(q.y * 1e3), std::llround(q.z * 1e3)}; } }
  const Track wrongRate = sample("A at 1.2 mean motion", circular(rA, nA, c0, 0, 1.2), steps);
  Track teleport = trackA; teleport.name = "teleport A -> B1 at step 43200";
  for (size_t j = steps / 2; j < steps; ++j) teleport.p[j] = trackB[0].p[j];
  Track scaled = trackA; scaled.name = "A scaled by 1.01";
  for (auto& p : scaled.p) for (int k = 0; k < 3; ++k) p[k] = std::llround(p[k] * 1.01);
  // The breadth set (2c): 200 geometries, seed 2, designed miss uniform in [0.5 R', 2 R'].
  std::mt19937_64 rng2(2);
  struct Geometry { Track b; double tc, missM; size_t block; };
  std::vector<Geometry> geometries;
  for (int k = 0; k < 200; ++k) {
    const double tc = span * (0.1 + 0.8 * uni(rng2));
    const double angle = (20 + 140 * uni(rng2)) * kPi / 180;
    const double missM = rprime * (0.5 + 1.5 * uni(rng2));
    const V3 c = unit(A.at(tc));
    const V3 dA = cross(nA, c);
    const V3 nB = add(mul(nA, std::cos(angle)), mul(dA, std::sin(angle)));
    const size_t block = (size_t)(tc / kN1);
    Geometry g{Track(), tc, missM, block};
    g.b = sample("G" + std::to_string(k + 1), circular(rA + missM / 1e3, nB, c, tc), steps);
    geometries.push_back(std::move(g));
  }

  // Per-window keys: one key pair per parameter set; B holds public and relin keys only.
  auto t0 = Clock::now();
  HEContext a1 = HEContext::CreateClient(kN1), a3 = HEContext::CreateClient(kN3);
  if (!a1.IsValid() || !a3.IsValid()) { std::fprintf(stderr, "context refused\n"); return 3; }
  const Bytes pk1 = a1.GetPublicKey(), rk1 = a1.GetRelinKeys(), pk3 = a3.GetPublicKey(), rk3 = a3.GetRelinKeys();
  HEContext b1 = HEContext::CreateServer(pk1.data(), pk1.size()), b3 = HEContext::CreateServer(pk3.data(), pk3.size());
  b1.SetRelinKeys(rk1.data(), rk1.size()); b3.SetRelinKeys(rk3.data(), rk3.size());
  const double keygenMs = ms(t0, Clock::now());
  const bool bHasSecret = b1.HasSecretKey() || b3.HasSecretKey();
  const double keyBytes = (double)(pk1.size() + rk1.size() + pk3.size() + rk3.size());

  // A's S2 submission (x, y, z per block, no |a|^2).
  Counters cA2;
  std::vector<std::vector<Bytes>> aBlocks(blocks1, std::vector<Bytes>(3));
  for (size_t w = 0; w < blocks1; ++w) for (int k = 0; k < 3; ++k) aBlocks[w][k] = encryptBlock(a1, trackA, w, kN1, k, 0, cA2);
  Counters cLine;
  std::vector<std::vector<Bytes>> lineBlocks(blocks1, std::vector<Bytes>(3));
  for (size_t w = 0; w < blocks1; ++w) for (int k = 0; k < 3; ++k) lineBlocks[w][k] = encryptBlock(a1, line, w, kN1, k, 0, cLine);

  Rng masks(a.seed + 7);
  // S2 screening, s = 0, and the noise pass.
  Counters cS2, cS2n, cS1, cS3;
  std::vector<DistanceResult> s2, s2n;
  for (size_t q = 0; q < pairs.size(); ++q) {
    s2.push_back(maskedDistance(a1, b1, aBlocks, trackA, trackB[q], rprime2, rprime2, 0, 0, steps, masks, cS2, true));
    s2n.push_back(maskedDistance(a1, b1, aBlocks, trackA, trackB[q], rprime2, raised2, noiseS, (double)noiseS / 4, steps, masks, cS2n, false));
  }
  // S1 tube check: A against its declared track, the line against it.
  DistanceResult tubeA = maskedDistance(a1, b1, aBlocks, trackA, declared, d02, d02, 0, 0, steps, masks, cS1, false);
  DistanceResult tubeLine = maskedDistance(a1, b1, lineBlocks, line, declared, d02, d02, 0, 0, steps, masks, cS1, false);
  // S3 physics check.
  std::vector<std::pair<std::string, PhysicsResult>> phys;
  std::vector<const Track*> physTracks = {&trackA};
  for (auto& t : trackB) physTracks.push_back(&t);
  physTracks.push_back(&line); physTracks.push_back(&wrongRate); physTracks.push_back(&teleport); physTracks.push_back(&scaled);
  // --threads t runs the tracks on t workers, each with its own per-window key
  // pair at n 16384 (the costs then carry the contention of t cores).
  std::vector<PhysicsResult> physOut(physTracks.size());
  std::vector<Counters> physCounters(std::max(1, a.threads));
  std::atomic<size_t> next{0};
  auto worker = [&](int id) {
    Rng wm(a.seed + 100 + (uint64_t)id);
    HEContext wa = HEContext::CreateClient(kN3);
    const Bytes wpk = wa.GetPublicKey(), wrk = wa.GetRelinKeys();
    HEContext wb = HEContext::CreateServer(wpk.data(), wpk.size());
    wb.SetRelinKeys(wrk.data(), wrk.size());
    if (wb.HasSecretKey()) { std::fprintf(stderr, "worker server context holds a secret key\n"); std::exit(3); }
    for (size_t i = next++; i < physTracks.size(); i = next++) physOut[i] = physicsCheck(wa, wb, *physTracks[i], a.stride, steps, wm, physCounters[(size_t)id]);
  };
  if (a.threads <= 1) { for (size_t i = 0; i < physTracks.size(); ++i) physOut[i] = physicsCheck(a3, b3, *physTracks[i], a.stride, steps, masks, cS3); }
  else {
    std::vector<std::thread> pool;
    for (int i = 0; i < a.threads; ++i) pool.emplace_back(worker, i);
    for (auto& th : pool) th.join();
    for (const auto& pc : physCounters) { cS3.ctxCtMultiplies += pc.ctxCtMultiplies; cS3.aEncryptMs += pc.aEncryptMs; cS3.aUploadBytes += pc.aUploadBytes; }
  }
  for (size_t i = 0; i < physTracks.size(); ++i) phys.emplace_back(physTracks[i]->name, physOut[i]);
  // Breadth set: the block holding each crossing, s = 0 and the noise pass.
  Counters cG;
  size_t gMisses = 0, gStepsBeyond = 0, gFalseAlerts = 0, gExtraBeyondRs = 0, gSteps = 0, gSign = 0, gValue = 0, gWithin = 0;
  size_t gWithinR = 0, gMissesBelowR = 0, gExtraBeyondBound = 0; double gMaxExtraM = 0;
  const double rM = a.thresholdKm * 1e3, extraBoundM = std::sqrt((double)raised2 + (double)noiseS);
  for (const auto& g : geometries) {
    DistanceResult r0 = maskedDistance(a1, b1, aBlocks, trackA, g.b, rprime2, rprime2, 0, 0, steps, masks, cG, false, g.block, g.block + 1);
    DistanceResult rn = maskedDistance(a1, b1, aBlocks, trackA, g.b, rprime2, raised2, noiseS, (double)noiseS / 4, steps, masks, cG, false, g.block, g.block + 1);
    gSign += r0.signMismatches; gValue += r0.valueMismatches + rn.valueMismatches;
    const size_t blockSteps = std::min(kN1 * (g.block + 1), steps) - kN1 * g.block;
    gSteps += blockSteps;
    if (g.missM < rprime) { ++gWithin; if (r0.alertSteps == 0 || r0.signMismatches) ++gMisses; }
    if (g.missM < rM) { ++gWithinR; if (r0.alertSteps == 0 || r0.signMismatches) ++gMissesBelowR; }
    gMaxExtraM = std::max(gMaxExtraM, rn.maxExtraDistanceM);
    if (rn.maxExtraDistanceM > extraBoundM) ++gExtraBeyondBound;
    gStepsBeyond += blockSteps - r0.plainAlertSteps;
    gFalseAlerts += rn.extra;
    if (rn.maxExtraDistanceM > rprime + sNoise) ++gExtraBeyondRs;
    if (rn.missed) ++gMisses;
  }
  // Reconstruction attempt (2a): A's view of pair 1's first block.
  size_t viewSteps = 0, viewWithin2 = 0; std::vector<double> viewErr;
  for (size_t j = 0; j < s2[0].aView.size(); ++j) {
    const Big v = s2[0].aView[j] + Big::From(rprime2);
    const double est = v.neg ? 0.0 : std::sqrt((double)v.m[0] + 18446744073709551616.0 * ((double)v.m[1] + 18446744073709551616.0 * (double)v.m[2]));
    const double truth = s2[0].trueDistanceM[j];
    ++viewSteps;
    if (est > 0 && truth > 0 && std::fabs(std::log2(est / truth)) <= 1.0) ++viewWithin2;
    viewErr.push_back(est > 0 && truth > 0 ? std::fabs(std::log2(est / truth)) : 1e9);
  }
  std::sort(viewErr.begin(), viewErr.end());

  // Multiplicative-mask leakage, restated from the plaintext values of this
  // run with the bench's method: r log-uniform below 2^120, 64-step runs.
  std::vector<double> leak;
  { std::mt19937_64 lr(a.seed + 11); std::uniform_int_distribution<int> expo(0, 119); std::uniform_real_distribution<double> frac(0, 1);
    for (const auto& pr : s2) {
      const size_t n = pr.values.size();
      std::vector<long double> logm(n);
      for (size_t j = 0; j < n; ++j) {
        const long double lv = std::log2((long double)std::fabs(std::strtold(pr.values[j].Str().c_str(), nullptr)) + 1);
        logm[j] = lv + expo(lr) + std::log2(1 + frac(lr));
      }
      for (size_t j = 0; j < n; j += 7) {
        const size_t lo = j >= 32 ? j - 32 : 0, hi = std::min(n - 1, j + 32);
        long double lower = -1e9, upper = 1e9;
        for (size_t k = lo; k <= hi; ++k) { lower = std::max(lower, logm[k] - 120); upper = std::min(upper, logm[k]); }
        const long double truth = std::log2((long double)std::fabs(std::strtold(pr.values[j].Str().c_str(), nullptr)) + 1);
        leak.push_back((double)std::fabs(0.5L * (lower + upper) - truth));
      }
    }
    std::sort(leak.begin(), leak.end()); }
  auto frac = [&](double bits) { return leak.empty() ? 0.0 : (double)(std::upper_bound(leak.begin(), leak.end(), bits) - leak.begin()) / leak.size(); };

  // ---- report ----
  const double np = (double)pairs.size();
  double s2B = 0, s2Resp = 0, s2Dec = 0; int s2Budget = 1 << 30; size_t mism = 0, valm = 0;
  for (auto& r : s2) { s2B += r.bComputeMs; s2Resp += r.bResponseBytes; s2Dec += r.aDecryptMs; s2Budget = std::min(s2Budget, r.minNoiseBudget); mism += r.signMismatches; valm += r.valueMismatches; }
  double s3B = 0, s3Resp = 0, s3Dec = 0; int s3Budget = 1 << 30;
  for (auto& p : phys) { s3B += p.second.bComputeMs; s3Resp += p.second.bResponseBytes; s3Dec += p.second.aDecryptMs; s3Budget = std::min(s3Budget, p.second.minNoiseBudget); }
  const double nPhys = (double)phys.size();
  std::printf("{\n  \"seal\": \"4.1.1\", \"scheme\": \"BFV\", \"forkCommit\": \"55a0ca86\", \"days\": %g, \"stepSeconds\": 1, \"steps\": %zu, \"physicsThreads\": %d,\n", a.days, steps, std::max(1, a.threads));
  std::printf("  \"parameters\": {\"screening\": {\"n\": %u, \"blocks\": %zu, \"depth\": 1}, \"physics\": {\"n\": %u, \"blocks\": %zu, \"depth\": 3, \"strideSeconds\": %ld}},\n",
              kN1, blocks1, kN3, (steps + kN3 - 1) / kN3, a.stride);
  std::printf("  \"thresholdKm\": %g, \"vmaxKmS\": %g, \"testedThresholdM\": %.1f, \"testedThresholdM2\": %lld, \"tubeM\": %lld,\n", a.thresholdKm, a.vmax, rprime, (long long)rprime2, (long long)d0);
  std::printf("  \"noise\": {\"sM\": %g, \"truncationM2\": %lld, \"raisedThresholdM2\": %lld, \"betaM2\": %g},\n", sNoise, (long long)noiseS, (long long)raised2, (double)noiseS / 4);
  std::printf("  \"decoys\": 0, \"publicTracksRead\": {\"screening\": 0, \"tube\": 1}, \"responderHasSecretKey\": %s,\n", bHasSecret ? "true" : "false");
  std::printf("  \"submittedVectorsPerBlock\": 3, \"ctxCtMultipliesPerBlock\": {\"screening\": %zu, \"tube\": %zu, \"physics\": %zu}, \"ctxCtMultiplies\": %zu,\n",
              cS2.ctxCtMultiplies / blocks1 / pairs.size(), cS1.ctxCtMultiplies / blocks1 / 2, cS3.ctxCtMultiplies / ((steps + kN3 - 1) / kN3) / phys.size(),
              cS2.ctxCtMultiplies + cS2n.ctxCtMultiplies + cS1.ctxCtMultiplies + cS3.ctxCtMultiplies);
  std::printf("  \"signMismatches\": %zu, \"valueMismatches\": %zu, \"minNoiseBudgetBits\": {\"screening\": %d, \"physics\": %d},\n", mism, valm, s2Budget, s3Budget);
  std::printf("  \"pairs\": [");
  for (size_t q = 0; q < pairs.size(); ++q) {
    const auto& r = s2[q]; const auto& n = s2n[q];
    std::printf("%s\n    {\"pair\": \"A-%s\", \"designedMissKm\": %.1f, \"plaintextAlertSteps\": %zu, \"protocolAlertSteps\": %zu, \"plaintextAlerts\": %s, \"protocolAlerts\": %s, \"signMismatches\": %zu, \"valueMismatches\": %zu, \"noise\": {\"missedAlerts\": %zu, \"extraAlerts\": %zu, \"maxExtraDistanceM\": %.1f, \"alertSteps\": %zu}}",
                q ? "," : "", trackB[q].name.c_str(), pairs[q].missKm, r.plainAlertSteps, r.alertSteps, list(r.plainAlertList).c_str(), list(r.alertList).c_str(),
                r.signMismatches, r.valueMismatches, n.missed, n.extra, n.maxExtraDistanceM, n.alertSteps);
  }
  std::printf("\n  ],\n");
  std::printf("  \"tube\": {\"A\": {\"insideSteps\": %zu, \"outsideSteps\": %zu, \"valueMismatches\": %zu}, \"line\": {\"insideSteps\": %zu, \"outsideSteps\": %zu, \"firstOutsideStep\": %ld, \"valueMismatches\": %zu}},\n",
              tubeA.alertSteps, steps - tubeA.alertSteps, tubeA.valueMismatches, tubeLine.alertSteps, steps - tubeLine.alertSteps,
              tubeLine.firstNonAlert, tubeLine.valueMismatches);
  std::printf("  \"physics\": [");
  for (size_t i = 0; i < phys.size(); ++i) {
    const auto& p = phys[i].second;
    std::printf("%s\n    {\"track\": \"%s\", \"stepsChecked\": %zu, \"passSteps\": %zu, \"failSteps\": %zu, \"mismatches\": %zu, \"firstFailStep\": %ld, \"sample\": {\"E\": \"%s\", \"EPlain\": \"%s\", \"F\": \"%s\", \"FPlain\": \"%s\"}}",
                i ? "," : "", phys[i].first.c_str(), p.stepsChecked, p.passSteps, p.failSteps, p.mismatches, p.firstFail, p.sampleE.c_str(), p.sampleEPlain.c_str(), p.sampleF.c_str(), p.sampleFPlain.c_str());
  }
  std::printf("\n  ],\n");
  std::printf("  \"returnedCiphertextsPerBlock\": {\"tube\": 1, \"screening\": 1, \"physics\": 2},\n");
  std::printf("  \"reconstruction\": {\"pair\": \"A-B1\", \"block\": 0, \"steps\": %zu, \"distanceWithinFactor2Share\": %.6f, \"medianLog2DistanceError\": %.2f},\n",
              viewSteps, viewSteps ? (double)viewWithin2 / viewSteps : 0.0, viewErr.empty() ? 0.0 : viewErr[viewErr.size() / 2]);
  std::printf("  \"breadth\": {\"geometries\": %zu, \"missRangeM\": [%.0f, %.0f], \"withinRprime\": %zu, \"misses\": %zu, \"signMismatches\": %zu, \"valueMismatches\": %zu, \"steps\": %zu, \"stepsBeyondRprime\": %zu, \"falseAlertStepsAtNoiseThreshold\": %zu, \"geometriesWithExtraBeyondRprimePlusS\": %zu, \"withinR\": %zu, \"missesBelowR\": %zu, \"extraAlertBoundM\": %.1f, \"maxExtraDistanceM\": %.1f, \"geometriesWithExtraBeyondBound\": %zu},\n",
              geometries.size(), 0.5 * rprime, 2 * rprime, gWithin, gMisses, gSign, gValue, gSteps, gStepsBeyond, gFalseAlerts, gExtraBeyondRs, gWithinR, gMissesBelowR, extraBoundM, gMaxExtraM, gExtraBeyondBound);
  std::printf("  \"maskLeakage\": {\"method\": \"multiplicative mask r log-uniform below 2^120, 64-step runs, restated from the plaintext values\", \"samples\": %zu, \"medianErrorBitsInDistanceSquared\": %.2f, \"withinFactor2InDistance\": %.3f, \"withinFactor10InDistance\": %.3f, \"private\": false},\n",
              leak.size(), leak.empty() ? 0.0 : leak[leak.size() / 2], frac(2.0), frac(2 * std::log2(10.0)));
  std::printf("  \"cost\": {\n");
  std::printf("    \"keygenMs\": %.1f, \"keyBytes\": %.0f,\n", keygenMs, keyBytes);
  std::printf("    \"screening8192\": {\"aEncryptPerObjectDayMs\": %.1f, \"aUploadPerObjectDayBytes\": %.0f, \"bComputePerPairDayMs\": %.1f, \"bResponsePerPairDayBytes\": %.0f, \"aDecryptPerPairDayMs\": %.1f, \"exchangedPerPairDayBytes\": %.0f},\n",
              cA2.aEncryptMs / a.days, cA2.aUploadBytes / a.days, s2B / np / a.days, s2Resp / np / a.days, s2Dec / np / a.days, (cA2.aUploadBytes / np + s2Resp / np) / a.days);
  std::printf("    \"physics16384\": {\"aEncryptPerObjectDayMs\": %.1f, \"aUploadPerObjectDayBytes\": %.0f, \"bComputePerObjectDayMs\": %.1f, \"bResponsePerObjectDayBytes\": %.0f, \"aDecryptPerObjectDayMs\": %.1f},\n",
              cS3.aEncryptMs / nPhys / a.days, cS3.aUploadBytes / nPhys / a.days, s3B / nPhys / a.days, s3Resp / nPhys / a.days, s3Dec / nPhys / a.days);
  std::printf("    \"exchangedPerPairDayBytesWithPhysics\": %.0f,\n", (cA2.aUploadBytes / np + s2Resp / np + cS3.aUploadBytes / nPhys / np + s3Resp / nPhys / np) / a.days);
  std::printf("    \"bench\": {\"bComputePerPairDayMs\": 169, \"bResponsePerPairDayBytes\": 8654481, \"aEncryptPerObjectDayMs\": 177.3, \"aUploadPerObjectDayBytes\": 34628616}\n");
  std::printf("  }\n}\n");
  return mism == 0 && valm == 0 ? 0 : 1;
}
