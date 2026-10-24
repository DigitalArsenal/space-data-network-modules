// The two-body problem in extended precision: the exact state of a Kepler orbit at any
// time, from BigInt fixed-point arithmetic with 60 decimal digits. This is the truth the
// integrator accuracy and the event epochs are measured against; it contains no
// integration. Units are the caller's (kilometers and seconds in the E2E).
const DIGITS = 60n;
const ONE = 10n ** DIGITS;
const fixed = (x) => BigInt(Math.round(x * 1e15)) * (ONE / 10n ** 15n);
const fromFixed = (x) => Number(x / (ONE / 10n ** 30n)) / 1e30;
const mul = (a, b) => (a * b) / ONE;
const div = (a, b) => (a * ONE) / b;
const abs = (a) => (a < 0n ? -a : a);

function atanInverse(n) { // arctan(1/n)
  const n2 = n * n;
  let term = ONE / n, sum = term, k = 1n, sign = -1n;
  while (term !== 0n) {
    term /= n2; k += 2n;
    sum += (sign * term) / k; sign = -sign;
  }
  return sum;
}
export const PI = 16n * atanInverse(5n) - 4n * atanInverse(239n);
const TWO_PI = 2n * PI;

function reduce(x) { // into [-pi, pi]
  let r = x % TWO_PI;
  if (r > PI) r -= TWO_PI;
  if (r < -PI) r += TWO_PI;
  return r;
}
export function sin(x) {
  const r = reduce(x), r2 = mul(r, r);
  let term = r, sum = r, k = 1n;
  while (abs(term) > 0n) {
    term = -mul(term, r2) / ((k + 1n) * (k + 2n)); k += 2n; sum += term;
  }
  return sum;
}
export function cos(x) { return sin(x + PI / 2n); }
export function sqrt(x) {
  if (x <= 0n) return 0n;
  let r = BigInt(Math.floor(Math.sqrt(fromFixed(x)) * 1e15)) * (ONE / 10n ** 15n);
  for (let i = 0; i < 6; i++) r = (r + div(x, r)) / 2n;
  return r;
}
export function atan2(y, x) { // via Newton on tan: refine a double guess
  let t = fixed(Math.atan2(fromFixed(y), fromFixed(x)));
  for (let i = 0; i < 8; i++) {
    const s = sin(t), c = cos(t);
    // residual of rotating (x, y) by -t onto the x axis: y c - x s = 0
    const f = mul(y, c) - mul(x, s);
    const df = -(mul(y, s) + mul(x, c));
    t -= div(f, df);
  }
  return t;
}

/** Solve M = E - e sin E. */
export function solveKepler(M, e) {
  let E = M + mul(e, sin(M));
  for (let i = 0; i < 30; i++) {
    const f = E - mul(e, sin(E)) - M;
    E -= div(f, ONE - mul(e, cos(E)));
    if (abs(f) < 10n ** 10n) break;
  }
  return E;
}

/** Mean anomaly of a true anomaly. */
export function meanFromTrue(nu, e) {
  const half = nu / 2n;
  const E = 2n * atan2(mul(sqrt(ONE - e), sin(half)), mul(sqrt(ONE + e), cos(half)));
  return E - mul(e, sin(E));
}

/**
 * An orbit given by a, e, i, raan, argp (radians, doubles) and the mean anomaly at t = 0.
 * mu in km^3/s^2. Returns functions of exact BigInt fixed-point numbers.
 */
export function orbit({ a, e, i, raan, argp, meanAnomaly0, mu }) {
  const A = fixed(a), E_ = fixed(e), MU = fixed(mu);
  const n = sqrt(div(MU, mul(mul(A, A), A)));
  const cO = cos(fixed(raan)), sO = sin(fixed(raan)), cI = cos(fixed(i)), sI = sin(fixed(i));
  const cW = cos(fixed(argp)), sW = sin(fixed(argp));
  // perifocal -> inertial: columns P, Q
  const P = [mul(cO, cW) - mul(mul(sO, sW), cI), mul(sO, cW) + mul(mul(cO, sW), cI), mul(sW, sI)];
  const Q = [-mul(cO, sW) - mul(mul(sO, cW), cI), -mul(sO, sW) + mul(mul(cO, cW), cI), mul(cW, sI)];
  const M0 = fixed(meanAnomaly0);
  const b = mul(A, sqrt(ONE - mul(E_, E_)));
  function stateAtMean(M) {
    const E = solveKepler(M, E_);
    const cE = cos(E), sE = sin(E);
    const x = mul(A, cE - E_), y = mul(b, sE);
    const r = mul(A, ONE - mul(E_, cE));
    const factor = div(mul(A, n), r); // a n / r = dE/dt
    const vp = [-mul(factor, mul(A, sE)), mul(factor, mul(b, cE))];
    const pos = [0, 1, 2].map((k) => mul(x, P[k]) + mul(y, Q[k]));
    const vel = [0, 1, 2].map((k) => mul(vp[0], P[k]) + mul(vp[1], Q[k]));
    return { pos, vel, E };
  }
  return {
    n,
    period: div(TWO_PI, n),
    state(t) { // t: seconds (double or BigInt fixed)
      const T = typeof t === 'bigint' ? t : fixed(t);
      const s = stateAtMean(M0 + mul(n, T));
      return { position: s.pos.map(fromFixed), velocity: s.vel.map(fromFixed) };
    },
    /** Time (seconds, double) at which the true anomaly nu (radians) is reached after t0, the first time at or after `after`. */
    timeOfTrueAnomaly(nu, after = 0) {
      const M = meanFromTrue(fixed(nu), E_);
      let T = div(M - M0, n);
      const period = div(TWO_PI, n);
      const A0 = fixed(after);
      while (T < A0) T += period;
      while (T - period >= A0) T -= period;
      return fromFixed(T);
    },
    period_s: fromFixed(div(TWO_PI, n)),
    meanMotion: fromFixed(n),
    P: P.map(fromFixed), Q: Q.map(fromFixed),
  };
}
