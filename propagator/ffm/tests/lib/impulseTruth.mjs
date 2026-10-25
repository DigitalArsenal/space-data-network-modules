// Shared by the impulse E2Es (start-epoch-impulse, sample-epoch-impulse): requests for a two-body Earth arc with
// impulses and the closed form they are scored against (tests/lib/keplerReference.mjs, 60-digit arithmetic). Nothing
// here integrates; JS builds requests, reads results and subtracts.
import { lane } from './planetary.mjs';
import { decodeResult, requestFor } from './prwCodec.mjs';
import { orbit as keplerOrbit } from './keplerReference.mjs';

export const failures = [];
export const check = (ok, message) => { if (!ok) { failures.push(message); console.log(`FAIL ${message}`); } };

export const MU = 398600.4418;
export const T0 = 2460000.5;                       // exact in a double
export const DAY = 86400;
export const at = (seconds) => T0 + seconds / DAY; // exact for the offsets used below (5400 s = 1/16 d, 2700 s = 1/32 d, 84.375 s = 1/1024 d)
export const R0 = [6878.137, 120.5, -45.25]; export const V0 = [0.05, 7.62, 1.2];
export const controls = { method: 'RKF78', initialStep: 20, minStep: 0.001, maxStep: 20, absTolerance: 1e-14, relTolerance: 1e-14 };
export const forces = { gravityMode: 'POINT_MASS', j2: false, mu: MU };
export const base = { epochJD: T0, position: R0, velocity: V0, forces, integrator: controls };
export const SPAN = 5400, HALF = 2700, SAMPLE = 4050;   // 3/64 d
export const QUARTER = 1350;                              // 1/64 d

export const add = (a, b) => a.map((x, i) => x + b[i]);
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const norm = (a) => Math.sqrt(dot(a, a));
export const scale = (a, s) => a.map((x) => x * s);
export const meters = (a, b) => 1000 * norm(a.map((x, i) => x - b[i]));

// The orbit through a Cartesian state (km, km/s) as the reference's elements; mean anomaly at the state's own time.
export function through(r, v) {
  const rn = norm(r), h = cross(r, v), hn = norm(h);
  const ev = add(scale(r, (dot(v, v) - MU / rn) / MU), scale(v, -dot(r, v) / MU)), e = norm(ev);
  const a = 1 / (2 / rn - dot(v, v) / MU), i = Math.acos(h[2] / hn);
  const nodeVec = [-h[1], h[0], 0], nn = norm(nodeVec);
  const raan = Math.atan2(nodeVec[1], nodeVec[0]);
  let argp = Math.acos(Math.max(-1, Math.min(1, dot(nodeVec, ev) / (nn * e)))); if (ev[2] < 0) argp = 2 * Math.PI - argp;
  let nu = Math.acos(Math.max(-1, Math.min(1, dot(ev, r) / (e * rn)))); if (dot(r, v) < 0) nu = 2 * Math.PI - nu;
  const E = 2 * Math.atan2(Math.sqrt(1 - e) * Math.sin(nu / 2), Math.sqrt(1 + e) * Math.cos(nu / 2));
  return keplerOrbit({ a, e, i, raan, argp, meanAnomaly0: E - e * Math.sin(E), mu: MU });
}
// The request's epochs are TDB labels and the integration clock is TT: an arc labelled `seconds` long lasts
// seconds * TT_PER_LABEL on it (the module reports the duration of the whole arc; TDB - TT drifts by under 2 ms per year's
// phase, so the ratio holds over an arc to 1e-12). The closed form integrates that duration.
let TT_PER_LABEL = 1;
export const setTtPerLabel = (ratio) => { TT_PER_LABEL = ratio; };
// Measures the label-to-TT ratio of this lane's arcs (the module reports an arc's duration).
export async function calibrate(kind) { TT_PER_LABEL = (await ask(kind, { ...base, targetJD: at(SPAN) })).propagatedDeltaSeconds / SPAN; }
export const exact = (r, v, seconds) => { const s = through(r, v).state(seconds * TT_PER_LABEL); return [...s.position, ...s.velocity]; };
// A kick at `kickSeconds` into the arc: the orbit of (r0, v0) up to it, of the kicked state after.
// Kicks [{ at, dv }] (label seconds into the arc, ascending) then the state `seconds` in: the orbit through the state, kick by kick.
export function chain(kicks, seconds) {
  let s = [...R0, ...V0], t = 0;
  for (const k of kicks) { s = exact(s.slice(0, 3), s.slice(3), k.at - t); s = [...s.slice(0, 3), ...add(s.slice(3), k.dv)]; t = k.at; }
  return exact(s.slice(0, 3), s.slice(3), seconds - t);
}
export function kicked(dv, kickSeconds, seconds) {
  if (kickSeconds === 0) return exact(R0, add(V0, dv), seconds);
  const s = exact(R0, V0, kickSeconds);
  return exact(s.slice(0, 3), add(s.slice(3), dv), seconds - kickSeconds);
}
export const rtn = (dv, r, v) => { const R = scale(r, 1 / norm(r)), N0 = cross(r, v), N = scale(N0, 1 / norm(N0)), T = cross(N, R);
  return add(add(scale(R, dv[0]), scale(T, dv[1])), scale(N, dv[2])); };

export async function ask(kind, params) {
  const h = await lane(kind);
  const response = await h.invoke(requestFor('propagate', params));
  if (response.statusCode !== 0) return { error: `${response.errorCode ?? ''}: ${response.errorMessage ?? ''}`, response };
  return { ...decodeResult(response), response };
}
export const state = (o) => [...o.position, ...o.velocity];
export const worst = (a, b) => ({ position: meters(a.slice(0, 3), b.slice(0, 3)), velocity: 1000 * norm(a.slice(3).map((x, i) => x - b[3 + i])) }); // m, m/s
export const BAR = { position: 1e-4, velocity: 1e-7 };   // 0.1 mm, 0.1 um/s; measured 1e-5 m and 1e-8 m/s at worst (the integrator's own error)
export const report = (label, a, b) => {
  const w = worst(a, b);
  console.log(`  ${label}: ${w.position.toExponential(2)} m, ${w.velocity.toExponential(2)} m/s`);
  check(w.position <= BAR.position && w.velocity <= BAR.velocity, `${label}: ${w.position} m, ${w.velocity} m/s from the closed form`);
};

export const DV = [0.002, 0.0031, -0.0012];                 // km/s (about 4 m/s)
export const DV_RTN = [0.0011, 0.0023, 0.0007];
export const kick = (dv, seconds, frame) => ({ epochJD: at(seconds), deltaV: dv, ...(frame ? { frame } : {}) });
