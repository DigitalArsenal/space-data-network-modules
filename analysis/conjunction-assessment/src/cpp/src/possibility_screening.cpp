// Screening admissible trajectories by possibility and necessity (Evidence-
// Supported ASO Catalog whitepaper, section 12, "Screening admissible
// trajectories"; TEAG, Jah 2026, Remark 3.7: N(A) = 1 - Pi(A^c)). Two
// representations of each object's admissible set at a common epoch near
// the encounter:
//
// mode 0, finite supports (e.g. the ESPF support points with their
//   possibilities): the event "collision" holds for a pair (i, j) when the
//   pair's closest approach under rectilinear relative motion within
//   +/- half_window of the epoch is within the combined hard-body radius R.
//   Joint possibility of a pair is min(pi_i, pi_j) (non-interactive objects;
//   correlated errors would need a joint support). Pi(C) is the largest joint
//   possibility of a colliding pair, N(C) = 1 - Pi(C^c).
// mode 1, ellipsoidal sets with Gaussian-shaped possibility kernels
//   pi(x) = exp(-d^2 / 2), d the distance in the set's shape metric (the
//   kernel of the ESPF 2025 paper, section 9.4, and TEAG's compatibility
//   assignment): the relative kernel is bounded from outside by the minimum-
//   trace ellipsoid containing the Minkowski sum of the two shapes (a
//   conservative possibility), and the event is evaluated in the encounter
//   plane at the nominal closest approach (the short-term encounter model of
//   Foster's and Chan's probabilities): Pi(C) = exp(-m^2 / 2), m the shape
//   distance from the mean miss vector to the disk of radius R; N(C) =
//   1 - exp(-m_out^2 / 2) when the mean miss lies inside the disk (m_out its
//   distance to the circle), else 0.
//
// Possibility and necessity are not collision probabilities. Finite support
// points screen only the encounters they sample; the enclosure question is
// the caller's (whitepaper section 12).
//
// Request ("request"): $SCR POSSIBILITY_REQUEST: COMBINED_RADIUS_M,
// HALF_WINDOW_S, MODEL, ALPHA_LEVELS; FiniteSupport: A_POINTS then B_POINTS
// (x y z vx vy vz, SI, one inertial frame; POSSIBILITY in (0, 1]);
// EllipsoidalKernel: A_KERNEL and B_KERNEL (CENTRE 6, SHAPE 36 row-major).
// Result ("result"): $SCR POSSIBILITY_RESULT: POSSIBILITY_COLLISION,
// NECESSITY_COLLISION, NECESSITY_NO_COLLISION, MIN_MISS_M, MAX_MISS_M,
// TCA_MIN_S, TCA_MAX_S, PAIRS, COLLIDING_PAIRS, then per alpha level
// (ALPHA_CUTS) the miss and closest-approach ranges over the pairs
// (FiniteSupport) or the alpha-cut (EllipsoidalKernel: the encounter-plane
// miss range of the cut) whose joint possibility is at least alpha.
#include <cmath>
#include <cstdint>
#include <cstring>
#include <limits>
#include <vector>

#include "../../../../estimation/src/teag.hpp"
#include <flatbuffers/flatbuffers.h>
#include "SCR_generated.h"
#include "space_data_module_invoke.h"

namespace ca_possibility {

using sdn::teag::Vec;
constexpr double kInf = std::numeric_limits<double>::infinity();

int fail(const char *code, const char *message) {
  plugin_set_error(code, message);
  return 400;
}

struct Approach { double miss, t; };

// Closest approach of r + v t over t in [-T, T].
Approach closest(const double *dr, const double *dv, double half_window) {
  const double vv = dv[0] * dv[0] + dv[1] * dv[1] + dv[2] * dv[2];
  double t = vv > 0 ? -(dr[0] * dv[0] + dr[1] * dv[1] + dr[2] * dv[2]) / vv : 0.0;
  t = std::max(-half_window, std::min(half_window, t)) + 0.0;  // no negative zero
  double m2 = 0;
  for (int i = 0; i < 3; ++i) {
    const double x = dr[i] + dv[i] * t;
    m2 += x * x;
  }
  return {std::sqrt(m2), t};
}

// min over |y| <= R of (y - mu)' C^-1 (y - mu) for a 2 x 2 shape C, and the
// distance from mu to the circle |y| = R (the boundary). Lagrange: y(lam) =
// (C^-1 + lam I)^-1 C^-1 mu, |y(lam)| = R, solved by bisection on lam
// (|y| decreases monotonically in lam >= 0, increases toward 0 for lam < 0
// down to -1/lambda_max(C)).
double distance_to_disk(const double *mu, const double *c, double radius, bool to_circle) {
  const double mnorm = std::hypot(mu[0], mu[1]);
  if (!to_circle && mnorm <= radius) return 0.0;
  // Eigen-decomposition of C (symmetric 2 x 2).
  const double a = c[0], b = c[1], d = c[3];
  const double tr = a + d, det = a * d - b * b, disc = std::sqrt(std::max(0.0, tr * tr / 4 - det));
  const double l1 = tr / 2 + disc, l2 = tr / 2 - disc;
  double e1[2], e2[2];
  if (std::abs(b) > 1e-300) { e1[0] = l1 - d; e1[1] = b; }
  else if (a >= d) { e1[0] = 1; e1[1] = 0; }
  else { e1[0] = 0; e1[1] = 1; }
  const double n1 = std::hypot(e1[0], e1[1]);
  e1[0] /= n1; e1[1] /= n1;
  e2[0] = -e1[1]; e2[1] = e1[0];
  const double m1 = mu[0] * e1[0] + mu[1] * e1[1], m2 = mu[0] * e2[0] + mu[1] * e2[1];
  // In the eigenbasis: y_k(lam) = m_k / (1 + lam l_k) solves the stationary
  // condition; |y(lam)| decreases in lam on (-1/l1, inf). Outside the disk
  // the nearest disk point has lam > 0; inside, the nearest circle point has
  // lam in (-1/l1, 0].
  auto ynorm = [&](double lam) { return std::hypot(m1 / (1 + lam * l1), m2 / (1 + lam * l2)); };
  double y1, y2;
  const double pole = -1.0 / l1 * (1 - 1e-15);
  if (mnorm <= radius && ynorm(pole) < radius) {
    // Hard case: the circle is reached only along the major axis at lam = -1/l1.
    y2 = std::abs(l1 - l2) > 0 ? m2 / (1 - l2 / l1) : m2;
    y1 = std::sqrt(std::max(0.0, radius * radius - y2 * y2)) * (m1 >= 0 ? 1.0 : -1.0);
  } else {
    double lo, hi;
    if (mnorm > radius) {
      lo = 0; hi = 1;
      while (ynorm(hi) > radius && hi < 1e300) hi *= 2;
    } else {
      lo = pole; hi = 0;
    }
    for (int it = 0; it < 300; ++it) {
      const double mid = 0.5 * (lo + hi);
      if (ynorm(mid) > radius) lo = mid; else hi = mid;
    }
    const double lam = 0.5 * (lo + hi);
    y1 = m1 / (1 + lam * l1);
    y2 = m2 / (1 + lam * l2);
    const double sc = radius / std::max(std::hypot(y1, y2), 1e-300);  // onto the circle exactly
    y1 *= sc; y2 *= sc;
  }
  const double z1 = y1 - m1, z2 = y2 - m2;
  return std::sqrt(z1 * z1 / l1 + z2 * z2 / l2);
}

}  // namespace ca_possibility

extern "C" int possibility_of_collision() {
  using namespace ca_possibility;
  int32_t index = plugin_find_input_index("request", 0);
  const plugin_input_frame_t *f = index < 0 ? nullptr : plugin_get_input_frame(static_cast<uint32_t>(index));
  if (!f || !f->payload || f->payload_length < 8)
    return fail("invalid-request", "request must be a $SCR POSSIBILITY_REQUEST");
  flatbuffers::Verifier verifier(f->payload, f->payload_length);
  if (!verifier.VerifyBuffer<SCR>("$SCR"))
    return fail("invalid-request", "request must be a $SCR POSSIBILITY_REQUEST");
  const SCRPossibilityRequest *q = flatbuffers::GetRoot<SCR>(f->payload)->POSSIBILITY_REQUEST();
  if (!q) return fail("invalid-request", "request must be a $SCR POSSIBILITY_REQUEST");
  const double radius = q->COMBINED_RADIUS_M(), window = q->HALF_WINDOW_S();
  const uint32_t mode = static_cast<uint32_t>(q->MODEL());
  const auto *alphas = q->ALPHA_LEVELS();
  const uint32_t na = alphas ? alphas->size() : 0;
  if (!(radius > 0) || !std::isfinite(radius) || !(window >= 0) || !std::isfinite(window) || mode > 1 || na > 64)
    return fail("invalid-request", "radius must be positive, half window non-negative, model FiniteSupport or EllipsoidalKernel, at most 64 alpha levels");
  std::vector<double> alpha(na);
  for (uint32_t k = 0; k < na; ++k)
    if (!((alpha[k] = alphas->Get(k)) > 0) || alpha[k] > 1) return fail("invalid-request", "alpha levels must be in (0, 1]");
  double pi_c = 0, pi_nc = 0, min_miss = kInf, max_miss = 0, tmin = kInf, tmax = -kInf;
  uint64_t pairs = 0, colliding = 0;
  std::vector<double> amin(na, kInf), amax(na, 0.0), atmin(na, kInf), atmax(na, -kInf);
  if (mode == 0) {
    const auto *pa = q->A_POINTS(), *pb = q->B_POINTS();
    const uint32_t ca = pa ? pa->size() : 0, cb = pb ? pb->size() : 0;
    if (ca == 0 || cb == 0 || ca > 200000 || cb > 200000) return fail("invalid-request", "each support needs 1 to 200000 points");
    std::vector<double> a(static_cast<size_t>(ca) * 7), b(static_cast<size_t>(cb) * 7);
    auto rows = [](const ::flatbuffers::Vector<const SCRPossibilityPoint *> *v, std::vector<double> &out) {
      for (uint32_t i = 0; i < v->size(); ++i) {
        const SCRPossibilityPoint *x = v->Get(i);
        const double row[7] = {x->X_M(), x->Y_M(), x->Z_M(), x->VX_M_S(), x->VY_M_S(), x->VZ_M_S(), x->POSSIBILITY()};
        for (int k = 0; k < 7; ++k)
          if (!std::isfinite(out[i * 7 + k] = row[k])) return false;
      }
      return true;
    };
    if (!rows(pa, a)) return fail("invalid-request", "support A is not finite");
    if (!rows(pb, b)) return fail("invalid-request", "support B is not finite");
    for (uint32_t i = 0; i < ca; ++i)
      if (!(a[i * 7 + 6] > 0) || a[i * 7 + 6] > 1) return fail("invalid-request", "possibilities must be in (0, 1]");
    for (uint32_t j = 0; j < cb; ++j)
      if (!(b[j * 7 + 6] > 0) || b[j * 7 + 6] > 1) return fail("invalid-request", "possibilities must be in (0, 1]");
    for (uint32_t i = 0; i < ca; ++i)
      for (uint32_t j = 0; j < cb; ++j) {
        double dr[3], dv[3];
        for (int k = 0; k < 3; ++k) { dr[k] = a[i * 7 + k] - b[j * 7 + k]; dv[k] = a[i * 7 + 3 + k] - b[j * 7 + 3 + k]; }
        const Approach c = closest(dr, dv, window);
        const double joint = std::min(a[i * 7 + 6], b[j * 7 + 6]);
        ++pairs;
        const bool hit = c.miss <= radius;
        if (hit) { ++colliding; pi_c = std::max(pi_c, joint); }
        else pi_nc = std::max(pi_nc, joint);
        min_miss = std::min(min_miss, c.miss); max_miss = std::max(max_miss, c.miss);
        tmin = std::min(tmin, c.t); tmax = std::max(tmax, c.t);
        for (uint32_t k = 0; k < na; ++k)
          if (joint >= alpha[k]) {
            amin[k] = std::min(amin[k], c.miss); amax[k] = std::max(amax[k], c.miss);
            atmin[k] = std::min(atmin[k], c.t); atmax[k] = std::max(atmax[k], c.t);
          }
      }
  } else {
    double center[2][6], shape[2][36];
    const SCRPossibilityKernel *kernels[2] = {q->A_KERNEL(), q->B_KERNEL()};
    for (int o = 0; o < 2; ++o) {
      const auto *ce = kernels[o] ? kernels[o]->CENTRE() : nullptr;
      const auto *sh = kernels[o] ? kernels[o]->SHAPE() : nullptr;
      if (!ce || ce->size() != 6) return fail("invalid-request", "each kernel needs a CENTRE of 6 values");
      if (!sh || sh->size() != 36) return fail("invalid-request", "each kernel needs a SHAPE of 36 values");
      for (uint32_t k = 0; k < 6; ++k) if (!std::isfinite(center[o][k] = ce->Get(k))) return fail("invalid-request", "kernel centre is not finite");
      for (uint32_t k = 0; k < 36; ++k) if (!std::isfinite(shape[o][k] = sh->Get(k))) return fail("invalid-request", "kernel shape is not finite");
    }
    Vec sa(shape[0], shape[0] + 36), sb(shape[1], shape[1] + 36), l;
    if (!sdn::teag::cholesky(sa, 6, &l) || !sdn::teag::cholesky(sb, 6, &l)) return fail("invalid-request", "kernel shapes must be positive definite");
    const Vec s = sdn::teag::minkowski_outer(sa, sb, 6);
    double dr[3], dv[3];
    for (int k = 0; k < 3; ++k) { dr[k] = center[0][k] - center[1][k]; dv[k] = center[0][3 + k] - center[1][3 + k]; }
    const Approach nominal = closest(dr, dv, window);
    const double t = nominal.t;
    // Position shape at the nominal closest approach: M = [I, t I].
    double c3[9] = {};
    for (int i = 0; i < 3; ++i)
      for (int j = 0; j < 3; ++j)
        c3[i * 3 + j] = s[i * 6 + j] + t * (s[(3 + i) * 6 + j] + s[i * 6 + 3 + j]) + t * t * s[(3 + i) * 6 + 3 + j];
    // Encounter plane: orthogonal to the relative velocity.
    const double vn = std::sqrt(dv[0] * dv[0] + dv[1] * dv[1] + dv[2] * dv[2]);
    if (!(vn > 0)) return fail("invalid-geometry", "the mean relative velocity is zero; the encounter plane is undefined");
    const double u[3] = {dv[0] / vn, dv[1] / vn, dv[2] / vn};
    double miss[3];
    for (int k = 0; k < 3; ++k) miss[k] = dr[k] + dv[k] * t;
    double e1[3], e2[3];
    const double along = miss[0] * u[0] + miss[1] * u[1] + miss[2] * u[2];
    for (int k = 0; k < 3; ++k) e1[k] = miss[k] - along * u[k];
    double n1 = std::sqrt(e1[0] * e1[0] + e1[1] * e1[1] + e1[2] * e1[2]);
    if (n1 < 1e-12 * (1 + nominal.miss)) {  // zero miss: any in-plane axis
      const double helper[3] = {std::abs(u[0]) < 0.9 ? 1.0 : 0.0, std::abs(u[0]) < 0.9 ? 0.0 : 1.0, 0.0};
      const double h = helper[0] * u[0] + helper[1] * u[1] + helper[2] * u[2];
      for (int k = 0; k < 3; ++k) e1[k] = helper[k] - h * u[k];
      n1 = std::sqrt(e1[0] * e1[0] + e1[1] * e1[1] + e1[2] * e1[2]);
    }
    for (double &v : e1) v /= n1;
    e2[0] = u[1] * e1[2] - u[2] * e1[1]; e2[1] = u[2] * e1[0] - u[0] * e1[2]; e2[2] = u[0] * e1[1] - u[1] * e1[0];
    const double *axes[2] = {e1, e2};
    double mu[2], c2[4];
    for (int p = 0; p < 2; ++p) {
      mu[p] = miss[0] * axes[p][0] + miss[1] * axes[p][1] + miss[2] * axes[p][2];
      for (int q = 0; q < 2; ++q) {
        double v = 0;
        for (int i = 0; i < 3; ++i)
          for (int j = 0; j < 3; ++j) v += axes[p][i] * c3[i * 3 + j] * axes[q][j];
        c2[p * 2 + q] = v;
      }
    }
    if (!(c2[0] > 0) || !(c2[0] * c2[3] - c2[1] * c2[2] > 0)) return fail("invalid-geometry", "the encounter-plane shape is degenerate");
    const bool inside = std::hypot(mu[0], mu[1]) <= radius;
    const double m = distance_to_disk(mu, c2, radius, false);
    pi_c = std::exp(-0.5 * m * m);
    pi_nc = inside ? std::exp(-0.5 * std::pow(distance_to_disk(mu, c2, radius, true), 2)) : 1.0;
    pairs = 1; colliding = inside ? 1 : 0;
    min_miss = max_miss = std::hypot(mu[0], mu[1]);
    tmin = tmax = t;
    // alpha-cut of the relative kernel in the plane: the ellipse
    // {y : (y - mu)' C^-1 (y - mu) <= -2 log alpha}; its distance range to the origin.
    for (uint32_t k = 0; k < na; ++k) {
      const double rho = std::sqrt(-2.0 * std::log(alpha[k]));
      double lo = kInf, hi = 0;
      Vec lc;
      Vec cc(c2, c2 + 4);
      sdn::teag::cholesky(cc, 2, &lc);
      for (int step = 0; step < 3600; ++step) {
        const double th = 2 * sdn::teag::kPi * step / 3600.0;
        const double w0 = rho * std::cos(th), w1 = rho * std::sin(th);
        const double y0 = mu[0] + lc[0] * w0, y1 = mu[1] + lc[2] * w0 + lc[3] * w1;
        const double dist = std::hypot(y0, y1);
        lo = std::min(lo, dist); hi = std::max(hi, dist);
      }
      // The origin inside the cut: the nearest miss is zero.
      const double z0 = -mu[0] / lc[0], z1 = (-mu[1] - lc[2] * z0) / lc[3];
      if (z0 * z0 + z1 * z1 <= rho * rho) lo = 0;
      amin[k] = lo; amax[k] = hi; atmin[k] = atmax[k] = t;
    }
  }
  flatbuffers::FlatBufferBuilder out(256 + na * 64);
  std::vector<flatbuffers::Offset<SCRAlphaCut>> cuts;
  for (uint32_t k = 0; k < na; ++k)
    cuts.push_back(CreateSCRAlphaCut(out, alpha[k], amin[k], amax[k], atmin[k], atmax[k]));
  const auto cutVector = out.CreateVector(cuts);
  const double nc = 1.0 - pi_nc, nnc = 1.0 - pi_c;
  SCRPossibilityResultBuilder rb(out);
  rb.add_POSSIBILITY_COLLISION(pi_c);
  rb.add_NECESSITY_COLLISION(nc);
  rb.add_NECESSITY_NO_COLLISION(nnc);
  rb.add_MIN_MISS_M(min_miss);
  rb.add_MAX_MISS_M(max_miss);
  rb.add_TCA_MIN_S(tmin);
  rb.add_TCA_MAX_S(tmax);
  rb.add_PAIRS(pairs);
  rb.add_COLLIDING_PAIRS(colliding);
  rb.add_ALPHA_CUTS(cutVector);
  const auto result = rb.Finish();
  SCRBuilder root(out);
  root.add_POSSIBILITY_RESULT(result);
  FinishSCRBuffer(out, root.Finish());
  return plugin_push_output_ex("result", "SCR.fbs", "$SCR", 0, "SCR", 0, 0, out.GetBufferPointer(), out.GetSize()) >= 0 ? 0 : 500;
}
