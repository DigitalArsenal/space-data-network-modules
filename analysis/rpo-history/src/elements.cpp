// analysis/rpo-history: osculating elements and relative orbital elements.
//
// Relative orbital elements are the quasi-nonsingular set of D'Amico (2010,
// "Autonomous formation flying in low Earth orbit", PhD thesis, TU Delft,
// eq. 2.2), chief c (the reference, here the target) and deputy d:
//   da  = (a_d - a_c) / a_c
//   dl  = (u_d - u_c) + (O_d - O_c) cos i_c        u = w + M, mean argument of latitude
//   dex = e_d cos w_d - e_c cos w_c
//   dey = e_d sin w_d - e_c sin w_c
//   dix = i_d - i_c
//   diy = (O_d - O_c) sin i_c
// from two-body osculating elements of the inertial states (GM of EGM-96 /
// WGS 84). Angle differences are wrapped to (-pi, pi]. The elements are
// written so a circular orbit (e = 0, w undefined) gives u = the true
// argument of latitude exactly, with no division by e.
namespace {

struct Osculating {
  bool ok = false;
  double a = 0;       // km
  double ex = 0, ey = 0;  // e cos w, e sin w (w from the ascending node)
  double i = 0;       // rad
  double raan = 0;    // rad
  double u = 0;       // mean argument of latitude w + M, rad
  Vec3 h{};           // unit orbit normal
};

double wrapPi(double x) {
  x = std::fmod(x + kPi, kTwoPi);
  if (x <= 0) x += kTwoPi;
  return x - kPi;
}

Osculating osculating(const Vec3& r, const Vec3& v) {
  Osculating o;
  const double rm = norm(r), v2 = dot(v, v);
  const Vec3 hv = cross(r, v);
  const double hm = norm(hv);
  if (!(rm > 0) || !(hm > 0)) return o;
  const double inv = 2.0 / rm - v2 / kMu;
  if (!(inv > 0)) return o;  // not elliptic
  o.a = 1.0 / inv;
  o.h = scale(hv, 1.0 / hm);
  o.i = std::atan2(std::hypot(o.h[0], o.h[1]), o.h[2]);
  // Node line; an equatorial orbit takes +x as its node (then dl and diy lose
  // meaning, as in D'Amico's set).
  Vec3 node{-hv[1], hv[0], 0.0};
  const double nm = norm(node);
  node = nm > 1e-12 * hm ? scale(node, 1.0 / nm) : Vec3{1.0, 0.0, 0.0};
  o.raan = std::atan2(node[1], node[0]);
  const Vec3 m = cross(o.h, node);
  const double rv = dot(r, v);
  Vec3 e;
  for (int k = 0; k < 3; ++k) e[k] = ((v2 - kMu / rm) * r[k] - rv * v[k]) / kMu;
  o.ex = dot(e, node);
  o.ey = dot(e, m);
  const double em = std::hypot(o.ex, o.ey);
  if (!(em < 1.0)) return o;
  const double uTrue = std::atan2(dot(r, m), dot(r, node));
  const double w = std::atan2(o.ey, o.ex);  // 0 for a circular orbit
  const double nu = uTrue - w;
  const double E = std::atan2(std::sqrt(1.0 - em * em) * std::sin(nu), em + std::cos(nu));
  const double M = E - em * std::sin(E);
  // u = w + M = uTrue + (M - nu); (E - nu) and e sin E vanish with e.
  o.u = uTrue + (wrapPi(E - nu) - em * std::sin(E));
  o.ok = std::isfinite(o.a) && std::isfinite(o.u);
  return o;
}

struct Roe {
  bool ok = false;
  double a = 0;  // chief semi-major axis, km
  double da = 0, dl = 0, dex = 0, dey = 0, dix = 0, diy = 0;
};

Roe relativeElements(const Osculating& c, const Osculating& d) {
  Roe q;
  if (!c.ok || !d.ok) return q;
  const double dO = wrapPi(d.raan - c.raan);
  q.a = c.a;
  q.da = (d.a - c.a) / c.a;
  q.dl = wrapPi(wrapPi(d.u - c.u) + dO * std::cos(c.i));
  q.dex = d.ex - c.ex;
  q.dey = d.ey - c.ey;
  q.dix = d.i - c.i;
  q.diy = dO * std::sin(c.i);
  q.ok = true;
  return q;
}

// Angle between two orbit planes (their unit normals), rad.
double planeAngle(const Vec3& h1, const Vec3& h2) { return std::atan2(norm(cross(h1, h2)), dot(h1, h2)); }
}  // namespace
