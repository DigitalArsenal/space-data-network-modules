// Private screening benchmark: the two-party homomorphic distance test of the
// fast-screening whitepaper ("Private screening"), on Microsoft SEAL 4.1.1.
//
// A (requester) holds its trajectory a(t) and its own BFV secret key. B
// (responder) holds b(t) in the clear and never holds a key that decrypts A.
//   1. A samples a(t) on a common grid (step dt), packs 8192 steps per
//      ciphertext, and sends Enc(ax), Enc(ay), Enc(az), Enc(|a|^2) under its
//      own key. Coordinates are integer metres. Three 60-bit plaintext moduli
//      (CRT) carry the range, so nothing wraps.
//   2. B forms, with plaintext-ciphertext products only,
//        Enc(r (|a-b|^2 - R'^2)) = r Enc(|a|^2) + sum_k (-2 b_k r) Enc(a_k)
//                                  + r (|b|^2 - R'^2),
//      with a fresh random r > 0 per step, log-uniform below 2^120.
//      R' = sqrt(R^2 + (vmax dt / 2)^2): a pair that comes within R between
//      two samples is within R' at the nearer one.
//   3. A decrypts the three residues and learns, per step, only the sign: the
//      steps where B is within R' of A. The magnitude is hidden by r.
// The benchmark checks every step's sign against the plaintext distance, and
// that a designed encounter within R is caught. It reports operation costs,
// ciphertext sizes and the remaining noise budget, and how much the
// multiplicative mask leaks: A bounds each |v| by [|m| 2^-120, |m|] and
// intersects the bounds of 64 neighbouring steps.
//
//   private_screening_bench [--days 1] [--step 1] [--threshold-km 5]
//                           [--vmax-kms 15.5] [--pairs 4] [--seed 1]
// Synthetic circular two-body orbits (mu = 398600.4418 km^3/s^2) give the
// trajectories; the costs do not depend on them.
#include <seal/seal.h>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <random>
#include <sstream>
#include <string>
#include <vector>

using u128 = unsigned __int128;
using Clock = std::chrono::steady_clock;

namespace {

constexpr double kMu = 398600.4418;  // km^3/s^2
constexpr double kPi = 3.14159265358979323846;
constexpr size_t kN = 8192;          // polynomial degree = slots per ciphertext

double ms(Clock::time_point a, Clock::time_point b) {
  return std::chrono::duration<double, std::milli>(b - a).count();
}

struct V3 {
  double x, y, z;
};
V3 add(V3 a, V3 b) { return {a.x + b.x, a.y + b.y, a.z + b.z}; }
V3 mul(V3 a, double s) { return {a.x * s, a.y * s, a.z * s}; }
V3 cross(V3 a, V3 b) { return {a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x}; }
V3 unit(V3 a) { return mul(a, 1.0 / std::sqrt(a.x * a.x + a.y * a.y + a.z * a.z)); }

// A circular orbit of radius r (km) in the plane with normal n, at direction c
// (in the plane) at time tc.
struct Orbit {
  double r, n;  // km, rad/s
  V3 c, d;      // in-plane unit vectors, d = normal x c
  double tc;
  V3 at(double t) const {
    const double u = n * (t - tc);
    return add(mul(c, r * std::cos(u)), mul(d, r * std::sin(u)));
  }
};
Orbit circular(double r, V3 normal, V3 c, double tc) {
  normal = unit(normal);
  return {r, std::sqrt(kMu / (r * r * r)), c, cross(normal, c), tc};
}

uint64_t mulmod(uint64_t a, uint64_t b, uint64_t m) { return static_cast<uint64_t>((u128)a * b % m); }
uint64_t powmod(uint64_t a, uint64_t e, uint64_t m) {
  uint64_t r = 1;
  for (a %= m; e; e >>= 1, a = mulmod(a, a, m))
    if (e & 1) r = mulmod(r, a, m);
  return r;
}
uint64_t inv(uint64_t a, uint64_t p) { return powmod(a, p - 2, p); }  // p prime
uint64_t mod_signed(__int128 v, uint64_t m) {
  __int128 r = v % (__int128)m;
  return static_cast<uint64_t>(r < 0 ? r + m : r);
}

// Mixed-radix (Garner) digits of the integer with residues x mod t[i].
void garner(const uint64_t x[3], const uint64_t t[3], uint64_t d[3]) {
  d[0] = x[0] % t[0];
  d[1] = mulmod((x[1] + t[1] - d[0] % t[1]) % t[1], inv(t[0] % t[1], t[1]), t[1]);
  uint64_t s = (d[0] % t[2] + mulmod(t[0] % t[2], d[1], t[2])) % t[2];
  d[2] = mulmod((x[2] + t[2] - s) % t[2], inv(mulmod(t[0] % t[2], t[1] % t[2], t[2]), t[2]), t[2]);
}

struct Args {
  double days = 1, step = 1, threshold_km = 5, vmax = 15.5;
  int pairs = 4;
  uint64_t seed = 1;
};

}  // namespace

int main(int argc, char** argv) {
  Args a;
  for (int i = 1; i + 1 < argc; i += 2) {
    const std::string k = argv[i];
    const double v = std::atof(argv[i + 1]);
    if (k == "--days") a.days = v;
    else if (k == "--step") a.step = v;
    else if (k == "--threshold-km") a.threshold_km = v;
    else if (k == "--vmax-kms") a.vmax = v;
    else if (k == "--pairs") a.pairs = static_cast<int>(v);
    else if (k == "--seed") a.seed = static_cast<uint64_t>(v);
    else { std::fprintf(stderr, "unknown option %s\n", k.c_str()); return 2; }
  }
  const size_t steps = static_cast<size_t>(std::ceil(a.days * 86400.0 / a.step));
  const size_t windows = (steps + kN - 1) / kN;
  const double rprime_m = std::sqrt(std::pow(a.threshold_km * 1e3, 2) + std::pow(a.vmax * 1e3 * a.step / 2, 2));
  const int64_t rprime2 = static_cast<int64_t>(std::ceil(rprime_m * rprime_m));

  // ── parameters: BFV n = 8192, 128-bit security (SEAL default q), three 60-bit t ──
  seal::EncryptionParameters base(seal::scheme_type::bfv);
  base.set_poly_modulus_degree(kN);
  base.set_coeff_modulus(seal::CoeffModulus::BFVDefault(kN, seal::sec_level_type::tc128));
  const auto plain = seal::PlainModulus::Batching(kN, {60, 60, 60});
  uint64_t t[3];
  std::vector<std::shared_ptr<seal::SEALContext>> ctx;
  for (int i = 0; i < 3; ++i) {
    t[i] = plain[i].value();
    auto p = base;
    p.set_plain_modulus(plain[i]);
    ctx.push_back(std::make_shared<seal::SEALContext>(p, true, seal::sec_level_type::tc128));
    if (!ctx.back()->parameters_set()) { std::fprintf(stderr, "invalid parameters\n"); return 1; }
  }
  int qbits = 0;
  for (const auto& m : base.coeff_modulus()) qbits += m.bit_count();

  // ── A's keys (once) ──
  std::vector<seal::SecretKey> sk;
  auto t0 = Clock::now();
  for (int i = 0; i < 3; ++i) {
    seal::KeyGenerator kg(*ctx[i]);
    sk.push_back(kg.secret_key());
  }
  const double keygen_ms = ms(t0, Clock::now());

  // ── trajectories: A, and B_k crossing A's orbit 2 km off at time tc_k; the
  // last B passes 60 km off, a control with no encounter ──
  std::mt19937_64 rng(a.seed);
  const V3 nA = unit({0.0, -std::sin(98 * kPi / 180), std::cos(98 * kPi / 180)});  // i = 98 deg, node at +x
  const double rA = 7078.137;
  std::uniform_real_distribution<double> uni(0, 1);
  struct Pair { Orbit b; double tc, miss_km; };
  std::vector<Pair> pairs;
  const double span = static_cast<double>(steps) * a.step;
  V3 c0 = unit(cross(nA, {0, 0, 1}));
  if (std::isnan(c0.x)) c0 = {1, 0, 0};
  for (int k = 0; k < a.pairs; ++k) {
    const double tc = span * (0.1 + 0.8 * uni(rng));
    const double angle = (20 + 140 * uni(rng)) * kPi / 180;  // plane angle
    const double miss = k + 1 == a.pairs ? 60.0 : 2.0;
    // A's position direction at tc defines the line of intersection.
    const Orbit A0 = circular(rA, nA, c0, 0);
    const V3 c = unit(A0.at(tc));
    const V3 dA = cross(nA, c);
    const V3 nB = add(mul(nA, std::cos(angle)), mul(dA, std::sin(angle)));  // rotated about c
    pairs.push_back({circular(rA + miss, nB, c, tc), tc, miss});
  }
  const Orbit A = circular(rA, nA, c0, 0);

  // ── run ──
  double enc_ms = 0, b_ms = 0, dec_ms = 0, upload_bytes = 0, response_bytes = 0;
  double b_prep_ms = 0;
  const size_t leak_run = 64;
  std::vector<double> leak_errors;  // |log2 estimate - log2 truth| of |d^2 - R'^2|
  int min_budget = 1 << 30;
  size_t mismatches = 0, alert_steps = 0;
  std::vector<int> pair_alerts(pairs.size(), 0);
  std::vector<double> pair_min_true(pairs.size(), 1e300);
  std::uniform_int_distribution<int> expo(0, 119);
  for (size_t w = 0; w < windows; ++w) {
    // A: encode and encrypt (seeded symmetric) the four vectors per modulus.
    std::vector<int64_t> ax(kN), ay(kN), az(kN), aa(kN);
    for (size_t j = 0; j < kN; ++j) {
      const V3 p = A.at((w * kN + j) * a.step);
      ax[j] = std::llround(p.x * 1e3); ay[j] = std::llround(p.y * 1e3); az[j] = std::llround(p.z * 1e3);
      aa[j] = ax[j] * ax[j] + ay[j] * ay[j] + az[j] * az[j];
    }
    std::vector<std::vector<seal::Ciphertext>> ea(3, std::vector<seal::Ciphertext>(4));
    for (int i = 0; i < 3; ++i) {
      seal::BatchEncoder be(*ctx[i]);
      seal::Encryptor enc(*ctx[i], sk[i]);
      const std::vector<int64_t>* src[4] = {&aa, &ax, &ay, &az};
      for (int k = 0; k < 4; ++k) {
        auto s = Clock::now();
        seal::Plaintext pt;
        be.encode(*src[k], pt);
        std::stringstream ss;
        upload_bytes += enc.encrypt_symmetric(pt).save(ss, seal::compr_mode_type::none);
        enc_ms += ms(s, Clock::now());
        ea[i][k].load(*ctx[i], ss);  // B receives
      }
    }
    for (size_t q = 0; q < pairs.size(); ++q) {
      // B: plaintexts r, -2 b_k r, r (|b|^2 - R'^2) mod t_i; then the sum.
      auto s = Clock::now();
      std::vector<u128> r(kN);
      std::vector<int64_t> bx(kN), by(kN), bz(kN);
      std::vector<__int128> cc(kN);
      for (size_t j = 0; j < kN; ++j) {
        const int e = expo(rng);
        r[j] = ((u128)1 << e) | (((u128)rng() << 64 | rng()) & (((u128)1 << e) - 1));
        const V3 p = pairs[q].b.at((w * kN + j) * a.step);
        bx[j] = std::llround(p.x * 1e3); by[j] = std::llround(p.y * 1e3); bz[j] = std::llround(p.z * 1e3);
        cc[j] = (__int128)bx[j] * bx[j] + (__int128)by[j] * by[j] + (__int128)bz[j] * bz[j] - rprime2;
      }
      std::vector<std::stringstream> response(3);
      for (int i = 0; i < 3; ++i) {
        seal::BatchEncoder be(*ctx[i]);
        seal::Evaluator ev(*ctx[i]);
        std::vector<uint64_t> pr(kN), px(kN), py(kN), pz(kN), pc(kN);
        for (size_t j = 0; j < kN; ++j) {
          const uint64_t rm = static_cast<uint64_t>(r[j] % t[i]);
          pr[j] = rm;
          px[j] = mulmod(mod_signed(-2 * (__int128)bx[j], t[i]), rm, t[i]);
          py[j] = mulmod(mod_signed(-2 * (__int128)by[j], t[i]), rm, t[i]);
          pz[j] = mulmod(mod_signed(-2 * (__int128)bz[j], t[i]), rm, t[i]);
          pc[j] = mulmod(mod_signed(cc[j], t[i]), rm, t[i]);
        }
        auto sp = Clock::now();
        seal::Plaintext Pr, Px, Py, Pz, Pc;
        be.encode(pr, Pr); be.encode(px, Px); be.encode(py, Py); be.encode(pz, Pz); be.encode(pc, Pc);
        b_prep_ms += ms(sp, Clock::now());
        seal::Ciphertext res, tmp;
        ev.multiply_plain(ea[i][0], Pr, res);
        ev.multiply_plain(ea[i][1], Px, tmp); ev.add_inplace(res, tmp);
        ev.multiply_plain(ea[i][2], Py, tmp); ev.add_inplace(res, tmp);
        ev.multiply_plain(ea[i][3], Pz, tmp); ev.add_inplace(res, tmp);
        ev.add_plain_inplace(res, Pc);
        ev.mod_switch_to_inplace(res, ctx[i]->last_parms_id());
        response_bytes += res.save(response[i], seal::compr_mode_type::none);
      }
      b_ms += ms(s, Clock::now());

      // A: decrypt the residues, recover each step's sign.
      s = Clock::now();
      std::vector<std::vector<uint64_t>> x(3);
      for (int i = 0; i < 3; ++i) {
        seal::Ciphertext ct;
        ct.load(*ctx[i], response[i]);
        seal::Decryptor dec(*ctx[i], sk[i]);
        min_budget = std::min(min_budget, dec.invariant_noise_budget(ct));
        seal::Plaintext pt;
        dec.decrypt(ct, pt);
        seal::BatchEncoder(*ctx[i]).decode(pt, x[i]);
      }
      uint64_t half[3], hd[3];
      for (int i = 0; i < 3; ++i) half[i] = (t[i] - 1) / 2;  // (T - 1) / 2 mod t_i
      garner(half, t, hd);
      std::vector<char> negative(kN);
      std::vector<long double> logm(kN);  // log2 |masked value|, for the leakage check
      const long double T = (long double)t[0] * t[1] * t[2];
      for (size_t j = 0; j < kN; ++j) {
        const uint64_t xs[3] = {x[0][j], x[1][j], x[2][j]};
        uint64_t d[3];
        garner(xs, t, d);
        bool greater = d[2] != hd[2] ? d[2] > hd[2] : d[1] != hd[1] ? d[1] > hd[1] : d[0] > hd[0];
        negative[j] = greater;  // above (T-1)/2: a negative integer
        const long double m = (long double)d[2] * t[0] * t[1] + (long double)d[1] * t[0] + d[0];
        logm[j] = std::log2(greater ? T - m : m);
      }
      dec_ms += ms(s, Clock::now());

      // Leakage of the multiplicative mask: A bounds |v| = r^-1 |m| by
      // [|m| 2^-120, |m|] at each step; over a run of neighbouring steps (whose
      // true |v| barely changes) the tightest bounds close in on |v|.
      for (size_t j = 0; j < kN && w * kN + j < steps; ++j) {
        const size_t lo = j >= leak_run / 2 ? j - leak_run / 2 : 0, hi = std::min(kN - 1, j + leak_run / 2);
        long double lower = -1e9, upper = 1e9;
        for (size_t k = lo; k <= hi; ++k) {
          lower = std::max(lower, logm[k] - 120);
          upper = std::min(upper, logm[k]);
        }
        const __int128 dx = (__int128)ax[j] - bx[j], dy = (__int128)ay[j] - by[j], dz = (__int128)az[j] - bz[j];
        const __int128 v = dx * dx + dy * dy + dz * dz - rprime2;
        const long double truth = std::log2((long double)(v < 0 ? -v : v) + 1);
        const long double estimate = 0.5L * (lower + upper);
        leak_errors.push_back(static_cast<double>(std::fabs(estimate - truth)));
      }

      // Check against the plaintext distance.
      for (size_t j = 0; j < kN && w * kN + j < steps; ++j) {
        const __int128 dx = (__int128)ax[j] - bx[j], dy = (__int128)ay[j] - by[j], dz = (__int128)az[j] - bz[j];
        const bool inside = dx * dx + dy * dy + dz * dz < rprime2;
        if (inside != static_cast<bool>(negative[j])) ++mismatches;
        if (negative[j]) { ++alert_steps; ++pair_alerts[q]; }
      }
    }
  }
  // True minimum distance of each designed encounter, scanned at 1 ms.
  for (size_t q = 0; q < pairs.size(); ++q) {
    for (double tt = pairs[q].tc - 5; tt <= pairs[q].tc + 5; tt += 0.001) {
      const V3 d = add(A.at(tt), mul(pairs[q].b.at(tt), -1));
      pair_min_true[q] = std::min(pair_min_true[q], std::sqrt(d.x * d.x + d.y * d.y + d.z * d.z));
    }
  }

  const double npairs = static_cast<double>(pairs.size());
  std::printf("{\n  \"seal\": \"4.1.1\", \"scheme\": \"BFV\", \"polyModulusDegree\": %zu, \"coeffModulusBits\": %d,\n", kN, qbits);
  std::printf("  \"plainModuli\": [%llu, %llu, %llu], \"security\": \"128-bit (SEAL tc128)\",\n",
              (unsigned long long)t[0], (unsigned long long)t[1], (unsigned long long)t[2]);
  std::printf("  \"days\": %g, \"stepSeconds\": %g, \"steps\": %zu, \"ciphertextsPerCoordinate\": %zu,\n", a.days, a.step, steps, windows);
  std::printf("  \"thresholdKm\": %g, \"vmaxKmS\": %g, \"testedThresholdKm\": %.4f,\n", a.threshold_km, a.vmax, rprime_m / 1e3);
  std::printf("  \"keygenMs\": %.1f,\n", keygen_ms);
  std::printf("  \"requester\": {\"encryptMs\": %.1f, \"uploadBytes\": %.0f, \"perObjectDayMs\": %.1f, \"perObjectDayBytes\": %.0f},\n",
              enc_ms, upload_bytes, enc_ms / a.days, upload_bytes / a.days);
  std::printf("  \"responder\": {\"perPairMs\": %.1f, \"perPairDayMs\": %.1f, \"encodeShareMs\": %.1f, \"responseBytesPerPair\": %.0f},\n",
              b_ms / npairs, b_ms / npairs / a.days, b_prep_ms / npairs, response_bytes / npairs);
  std::printf("  \"requesterDecrypt\": {\"perPairMs\": %.1f},\n", dec_ms / npairs);
  std::printf("  \"minNoiseBudgetBits\": %d, \"signMismatches\": %zu, \"alertSteps\": %zu,\n", min_budget, mismatches, alert_steps);
  std::sort(leak_errors.begin(), leak_errors.end());
  auto frac = [&](double bits) {
    return static_cast<double>(std::upper_bound(leak_errors.begin(), leak_errors.end(), bits) - leak_errors.begin()) / leak_errors.size();
  };
  // A distance d follows from d^2 = R'^2 + v; an error of e bits in v is e/2 bits in d.
  std::printf("  \"maskLeakage\": {\"runSteps\": %zu, \"medianErrorBitsInDistanceSquared\": %.2f, \"withinFactor2InDistance\": %.3f, \"withinFactor10InDistance\": %.3f},\n",
              leak_run, leak_errors[leak_errors.size() / 2], frac(2.0), frac(2 * std::log2(10.0)));
  std::printf("  \"pairs\": [");
  for (size_t q = 0; q < pairs.size(); ++q)
    std::printf("%s\n    {\"designedMissKm\": %.1f, \"trueMinKm\": %.4f, \"alertSteps\": %d}", q ? "," : "", pairs[q].miss_km,
                pair_min_true[q], pair_alerts[q]);
  std::printf("\n  ]\n}\n");
  return mismatches == 0 ? 0 : 1;
}
