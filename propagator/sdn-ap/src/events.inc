// -----------------------------------------------------------------------------
// SDN-AP 5.1 (DESIGN section 5): maneuvers as boundaries between Earth sets.
// One operator serves them: the inverse of the output map, y = h^-1(x, t), the
// mean elements whose output state at their epoch is the osculating state x,
// solved by the fixed-point iteration y_{k+1} = y_k + (q(x) - q(h(y_k))) in
// equinoctial elements q (Walter 1967: the Jacobian is the identity to O(J2)).
// An impulse Delta v (UVW axes of the pre-maneuver state: U radial, W along
// r x v, V = W x U) maps the pre-maneuver set to the post-maneuver set at t_b,
// y+ = h^-1(x-(t_b) + (0, Delta v), t_b) (14); a finite burn of duration D is
// that map at its centroid with the eccentricity-vector and plane increments
// scaled by sinc(Delta L / 2), Delta L = n D (15: the arc loss).
// -----------------------------------------------------------------------------

namespace sdnap {
namespace events {

/// The gravitational parameter of the SGP4XP / SDN-AP Earth theories (SPEC 1.3), km^3/s^2.
inline double mu_xp() { return xpt::kKe * xpt::kKe * xpt::kRe * xpt::kRe * xpt::kRe / 3600.0; }

/// Equinoctial elements q = (n rad/min, a_f, a_g, chi, psi, lambda) of a set's mean elements.
inline void eq_of_elements(const Elements& e, double* q) {
  const double varpi = e.argpo + e.nodeo, t = std::tan(0.5 * e.inclo);
  q[0] = e.no_kozai;
  q[1] = e.ecco * std::cos(varpi);
  q[2] = e.ecco * std::sin(varpi);
  q[3] = t * std::sin(e.nodeo);
  q[4] = t * std::cos(e.nodeo);
  q[5] = e.mo + varpi;
}

/// The set's mean elements from q (its other fields kept). False for e >= 1 or a non-positive mean motion.
inline bool set_eq(Elements& e, const double* q) {
  const double ecc = std::sqrt(q[1] * q[1] + q[2] * q[2]);
  if (!(q[0] > 0.0) || !(ecc < 1.0)) return false;
  const double node = std::atan2(q[3], q[4]), varpi = std::atan2(q[2], q[1]);
  e.no_kozai = q[0];
  e.ecco = ecc;
  e.inclo = 2.0 * std::atan(std::sqrt(q[3] * q[3] + q[4] * q[4]));
  e.nodeo = xpt::wrap(node);
  e.argpo = xpt::wrap(varpi - node);
  e.mo = xpt::wrap(q[5] - varpi);
  return true;
}

/// Osculating equinoctial elements of a TEME state (km, km/s) about mu_xp.
inline bool eq_of_state(const double* r, const double* v, double* q) {
  double el[6];
  if (!segment::elements_of(mu_xp(), r, v, el) || !(el[1] < 1.0)) return false;
  const double varpi = el[3] + el[4], t = std::tan(0.5 * el[2]);
  q[0] = std::sqrt(mu_xp() / (el[0] * el[0] * el[0])) * 60.0;
  q[1] = el[1] * std::cos(varpi);
  q[2] = el[1] * std::sin(varpi);
  q[3] = t * std::sin(el[3]);
  q[4] = t * std::cos(el[3]);
  q[5] = el[5] + varpi;
  return true;
}

/// The output state at t minutes from a set's epoch (TEME km, km/s); false when the set is refused or decays.
inline bool state_of_set(const Elements& e, double t, double* r, double* v) {
  xpt::XpSat* s = static_cast<xpt::XpSat*>(std::malloc(sizeof(xpt::XpSat)));
  if (s == nullptr) return false;
  drag::table();
  bool ok = xpt::xp_init(e, *s) == kPropOk && xpt::xp_propagate(*s, t, r, v) == kPropOk;
  xpt::xp_release(*s);
  std::free(s);
  return ok;
}

/// The inverse map at the epoch of `e`: its mean elements replaced so that the set's output state at its epoch is
/// (r, v); the other fields (theory, drag and SRP parameters) kept. Iterations in *iterations; false when it does
/// not converge to 1e-9 km and 1e-12 km/s in 20 steps.
inline bool inverse_at_epoch(Elements& e, const double* r, const double* v, int* iterations = nullptr) {
  double target[6], q[6];
  if (!eq_of_state(r, v, target)) return false;
  // the start: the osculating elements taken as mean
  if (!set_eq(e, target)) return false;
  for (int it = 0; it < 20; ++it) {
    double ro[3], vo[3], qo[6];
    if (!state_of_set(e, 0.0, ro, vo) || !eq_of_state(ro, vo, qo)) return false;
    const double dr = std::sqrt((ro[0] - r[0]) * (ro[0] - r[0]) + (ro[1] - r[1]) * (ro[1] - r[1]) + (ro[2] - r[2]) * (ro[2] - r[2]));
    const double dv = std::sqrt((vo[0] - v[0]) * (vo[0] - v[0]) + (vo[1] - v[1]) * (vo[1] - v[1]) + (vo[2] - v[2]) * (vo[2] - v[2]));
    if (iterations) *iterations = it;
    if (dr < 1e-9 && dv < 1e-12) return true;
    eq_of_elements(e, q);
    for (int j = 0; j < 6; ++j) {
      double d = target[j] - qo[j];
      if (j == 5) d = std::remainder(d, kTwoPi);
      q[j] += d;
    }
    if (!set_eq(e, q)) return false;
  }
  return false;
}

/// The TEME vector of a UVW vector of the state (r, v).
inline void uvw_to_teme(const double* r, const double* v, const double* uvw, double* out) {
  const double rn = std::sqrt(r[0] * r[0] + r[1] * r[1] + r[2] * r[2]);
  double U[3] = {r[0] / rn, r[1] / rn, r[2] / rn};
  double W[3] = {r[1] * v[2] - r[2] * v[1], r[2] * v[0] - r[0] * v[2], r[0] * v[1] - r[1] * v[0]};
  const double wn = std::sqrt(W[0] * W[0] + W[1] * W[1] + W[2] * W[2]);
  for (double& x : W) x /= wn;
  const double V[3] = {W[1] * U[2] - W[2] * U[1], W[2] * U[0] - W[0] * U[2], W[0] * U[1] - W[1] * U[0]};
  const double q[3] = {uvw[0], uvw[1], uvw[2]};  // out may alias uvw
  for (int c = 0; c < 3; ++c) out[c] = q[0] * U[c] + q[1] * V[c] + q[2] * W[c];
}

/// The set's epoch moved by `minutes` (split Julian date kept normalized) and its epoch-referred SDN-AP times shifted.
inline Elements moved(const Elements& e, double minutes) {
  Elements o = e;
  double frac = e.epoch_jd_frac + minutes / kMinutesPerDay;
  const double whole_days = std::floor(frac);
  o.epoch_jd_whole = e.epoch_jd_whole + whole_days;
  o.epoch_jd_frac = frac - whole_days;
  o.arc_end_min = e.arc_end_min - minutes;
  return o;
}

struct Boundary {
  double r_pre[3], v_pre[3], r_post[3], v_post[3];  ///< TEME at the boundary epoch
  int iterations = 0;
  double sinc = 1.0;  ///< the arc-loss factor applied (1 for an impulse)
};

/// The maneuver map: the post-maneuver set of `pre` for a burn centred `t_c` minutes after its epoch, Delta v
/// (km/s, UVW of the pre-maneuver state at t_c) spread over `duration_s` seconds (0: an impulse). The post set's
/// epoch is t_c. False when a map does not converge.
inline bool maneuver_map(const Elements& pre, double t_c, const double* dv_uvw, double duration_s, Elements& post, Boundary& b) {
  if (!state_of_set(pre, t_c, b.r_pre, b.v_pre)) return false;
  double dv[3];
  uvw_to_teme(b.r_pre, b.v_pre, dv_uvw, dv);
  for (int c = 0; c < 3; ++c) { b.r_post[c] = b.r_pre[c]; b.v_post[c] = b.v_pre[c] + dv[c]; }
  post = moved(pre, t_c);
  if (!inverse_at_epoch(post, b.r_post, b.v_post, &b.iterations)) return false;
  if (duration_s > 0.0) {
    // (15): the impulse at the centroid overstates the eccentricity-vector and plane changes, and the cross-track
    // part of the mean longitude's, by 1 / sinc(Delta L / 2)
    Elements before = moved(pre, t_c);
    if (!inverse_at_epoch(before, b.r_pre, b.v_pre)) return false;
    double q0[6], q1[6];
    eq_of_elements(before, q0);
    eq_of_elements(post, q1);
    const double half = 0.5 * (q0[0] / 60.0) * duration_s;  // Delta L / 2 (n in rad/s)
    b.sinc = half > 1e-8 ? std::sin(half) / half : 1.0;
    for (int j = 1; j <= 4; ++j) q1[j] = q0[j] + (q1[j] - q0[j]) * b.sinc;
    // and the cross-track part of the mean longitude's step, periodic in L like them (W moves lambda through the
    // chi, psi coupling of the Gauss equations); the in-plane part (the radial impulse's -2 dv_U / (n a)) is not
    if (dv_uvw[2] != 0.0) {
      const double w_only[3] = {0.0, 0.0, dv_uvw[2]};
      double dvw[3], vw[3];
      uvw_to_teme(b.r_pre, b.v_pre, w_only, dvw);
      for (int c = 0; c < 3; ++c) vw[c] = b.v_pre[c] + dvw[c];
      Elements wset = moved(pre, t_c);
      if (!inverse_at_epoch(wset, b.r_pre, vw)) return false;
      double qw[6];
      eq_of_elements(wset, qw);
      q1[5] -= (1.0 - b.sinc) * std::remainder(qw[5] - q0[5], kTwoPi);
    }
    if (!set_eq(post, q1)) return false;
    // the post-burn state the scaled set writes at its epoch
    if (!state_of_set(post, 0.0, b.r_post, b.v_post)) return false;
  }
  return true;
}

}  // namespace events
}  // namespace sdnap
