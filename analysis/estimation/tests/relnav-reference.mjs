// Independent reference for the RTN relative-state conversion of the
// `relative_state` method, written from its definition and not from the C++.
//
// CONFORMANCE TOOLING (graph/checks/no-js-physics.mjs, class `test`): this file
// adjudicates the C++ WASM module from under a test tree. It is never imported
// by a shipped bundle and never runs inside a filter; the filters, the
// conversion the E2E uses and every number it scores come from the module.
//
// Definition (CCSDS RTN; the state layout of Estimation.fbs, extension v5):
//   R = r_c/|r_c|,  N = (r_c x v_c)/|r_c x v_c|,  T = N x R,
//   position  rho = [R, T, N]' (r_d - r_c),
//   rates     rho_dot = [R, T, N]' (v_d - v_c) - omega x rho, the rates of the
//             rotating frame, with omega = (r_c x v_c)/|r_c|^2 along N,
// and the chief's osculating a, e, i and true anomaly about mu.
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => Math.sqrt(dot(a, a));
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const minus = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

// chief, deputy: inertial [x, y, z, vx, vy, vz] (SI). Returns
// { state: [R, T, N, Rdot, Tdot, Ndot], chief: { a, e, i, nu } }.
export function relativeStateReference(mu, chief, deputy) {
  const r = chief.slice(0, 3), v = chief.slice(3, 6), rn = norm(r);
  const h = cross(r, v), hn = norm(h);
  const R = scale(r, 1 / rn), N = scale(h, 1 / hn), T = cross(N, R);
  const dr = minus(deputy.slice(0, 3), r), dv = minus(deputy.slice(3, 6), v);
  const rho = [dot(R, dr), dot(T, dr), dot(N, dr)];
  const omega = hn / (rn * rn);
  // omega x rho for omega along N: (-omega rho_T, omega rho_R, 0).
  const rate = [dot(R, dv) + omega * rho[1], dot(T, dv) - omega * rho[0], dot(N, dv)];
  const a = 1 / (2 / rn - dot(v, v) / mu);
  const evec = minus(scale(r, dot(v, v) / mu - 1 / rn), scale(v, dot(r, v) / mu));
  const e = norm(evec);
  const radialRate = dot(r, v) / rn;
  // True anomaly from the eccentricity vector and the sign of the radial rate.
  let nu = Math.acos(Math.max(-1, Math.min(1, dot(evec, r) / (e * rn))));
  if (radialRate < 0) nu = 2 * Math.PI - nu;
  return { state: [...rho, ...rate], chief: { a, e, i: Math.acos(h[2] / hn), nu } };
}

// ---- curvilinear RTN (RelativeNavConfig.curvilinear), from its definition ----
// With the chief at radius r and radial rate rdot, a deputy at rectilinear (x, y, z) is at
// X = r + x, radius rd = |(X, y, z)|, in-plane angle th = atan2(y, X) and out-of-plane angle
// ph = atan2(z, hypot(X, y)). The curvilinear state is [rd - r, r th, r ph] followed by the time
// derivatives of those three (r varies with the chief's true anomaly).
export function chiefRadial(mu, a, e, nu) {
  const p = a * (1 - e * e);
  return { r: p / (1 + e * Math.cos(nu)), rdot: Math.sqrt(mu / p) * e * Math.sin(nu) };
}
export function curvilinearFromRectilinear({ r, rdot }, s) {
  const X = r + s[0], y = s[1], z = s[2], Xd = rdot + s[3], plane = Math.hypot(X, y), rd = Math.hypot(plane, z);
  const rdd = (X * Xd + y * s[4] + z * s[5]) / rd;
  const th = Math.atan2(y, X), thd = (X * s[4] - y * Xd) / (plane * plane);
  const ph = Math.atan2(z, plane), phd = (s[5] * rd - z * rdd) / (rd * plane);
  return [rd - r, r * th, r * ph, rdd - rdot, rdot * th + r * thd, rdot * ph + r * phd];
}
// The mapped state and covariance J P J' with J by central differences (1 m in positions, 1 mm/s in rates).
export function curvilinearBelief(radial, state, covariance) {
  const J = Array.from({ length: 36 }, () => 0);
  for (let j = 0; j < 6; ++j) {
    const h = j < 3 ? 1 : 1e-3, plus = state.slice(), minus = state.slice();
    plus[j] += h; minus[j] -= h;
    const fp = curvilinearFromRectilinear(radial, plus), fm = curvilinearFromRectilinear(radial, minus);
    for (let i = 0; i < 6; ++i) J[6 * i + j] = (fp[i] - fm[i]) / (2 * h);
  }
  const JP = Array.from({ length: 36 }, (_, k) => { const [i, j] = [Math.floor(k / 6), k % 6]; let s = 0; for (let m = 0; m < 6; ++m) s += J[6 * i + m] * covariance[6 * m + j]; return s; });
  const out = Array.from({ length: 36 }, (_, k) => { const [i, j] = [Math.floor(k / 6), k % 6]; let s = 0; for (let m = 0; m < 6; ++m) s += JP[6 * i + m] * J[6 * j + m]; return s; });
  const symmetric = out.map((v, k) => 0.5 * (v + out[6 * (k % 6) + Math.floor(k / 6)]));
  return { state: curvilinearFromRectilinear(radial, state), covariance: symmetric };
}

// ---- nodal elements of an inertial state (independent of the module) ----
// u is the argument of latitude (the angle the radius vector sweeps from the node), (ex, ey) the eccentricity vector
// in the node frame (omega = atan2(ey, ex)); omega + nu = u at any eccentricity.
export function nodalElements(mu, state) {
  const r = state.slice(0, 3), v = state.slice(3, 6), rn = norm(r), h = cross(r, v), hh = scale(h, 1 / norm(h));
  const node = scale(cross([0, 0, 1], hh), 1 / Math.hypot(hh[0], hh[1])), perp = cross(hh, node);
  const evec = minus(scale(r, dot(v, v) / mu - 1 / rn), scale(v, dot(r, v) / mu));
  return { u: Math.atan2(dot(r, perp), dot(r, node)), ex: dot(evec, node), ey: dot(evec, perp), inclination: Math.acos(hh[2]) };
}
