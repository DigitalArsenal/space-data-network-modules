// Scoring tooling of the relative-navigation and innovation-recovery E2E: a
// seeded noise source, statistics of the filtered histories and the
// chi-square quantiles the consistency bands use. Test arithmetic only; every
// filter result it scores comes from the module.
//
// NEES: epsilon' P^-1 epsilon with epsilon = estimate - truth; a consistent
// filter has E[NEES] = 6 (Bar-Shalom, Li and Kirubarajan 2001, 5.4). The
// quantiles use the Wilson-Hilferty cube-root approximation of the
// chi-square distribution (Wilson and Hilferty 1931), accurate to better
// than 0.1 % for the 360 degrees of freedom they are used with.
const Z_995 = 2.5758293035489004;   // standard normal quantile of 0.995

// ---- seeded noise (xoshiro128**, Box-Muller; Blackman and Vigna 2018) ----
export function makeRng(seed) {
  let a = seed >>> 0, b = 0x9e3779b9, c = 0x243f6a88, d = 0xb7e15162;
  const mix = () => { a = (a + 0x9e3779b9) | 0; let t = a ^ (a >>> 16); t = Math.imul(t, 0x21f0aaad); t ^= t >>> 15; t = Math.imul(t, 0x735a2d97); return (t ^ (t >>> 15)) >>> 0; };
  a = mix(); b = mix(); c = mix(); d = mix();
  const rotl = (x, k) => (x << k) | (x >>> (32 - k));
  const next = () => {
    const result = Math.imul(rotl(Math.imul(b, 5), 7), 9) >>> 0, t = b << 9;
    c ^= a; d ^= b; b ^= c; a ^= d; c ^= t; d = rotl(d, 11);
    return result;
  };
  let spare = null;
  const uniform = () => (next() + 0.5) / 4294967296;
  const normal = () => {
    if (spare !== null) { const s = spare; spare = null; return s; }
    const u = uniform(), v = uniform(), r = Math.sqrt(-2 * Math.log(u));
    spare = r * Math.sin(2 * Math.PI * v);
    return r * Math.cos(2 * Math.PI * v);
  };
  return { uniform, normal };
}

// ---- small dense linear algebra (6 x 6 row-major) ----
export function cholesky(matrix, n = 6) {
  const l = new Array(n * n).fill(0);
  for (let i = 0; i < n; ++i) for (let j = 0; j <= i; ++j) {
    let s = matrix[i * n + j];
    for (let k = 0; k < j; ++k) s -= l[i * n + k] * l[j * n + k];
    if (i === j) { if (!(s > 0)) throw new Error('matrix is not positive definite'); l[i * n + i] = Math.sqrt(s); } else l[i * n + j] = s / l[j * n + j];
  }
  return l;
}
// x = L z for lower-triangular L.
export const lowerTimes = (l, z, n = 6) => Array.from({ length: n }, (_, i) => { let s = 0; for (let k = 0; k <= i; ++k) s += l[i * n + k] * z[k]; return s; });
// v' P^-1 v by forward substitution on the Cholesky factor of P.
export function quadraticForm(p, v, n = 6) {
  const l = cholesky(p, n), w = new Array(n);
  let q = 0;
  for (let i = 0; i < n; ++i) { let s = v[i]; for (let k = 0; k < i; ++k) s -= l[i * n + k] * w[k]; w[i] = s / l[i * n + i]; q += w[i] * w[i]; }
  return q;
}

// state + L xi, xi ~ N(0, I): a draw from N(state, L L').
export const draw = (rng, state, lower) => { const x = lowerTimes(lower, Array.from({ length: 6 }, () => rng.normal())); return state.map((s, i) => s + x[i]); };

// ---- chi-square ----
export const chiSquareQuantile = (dof, p) => {
  // Wilson-Hilferty: chi2_p ~ k (1 - 2/(9k) + z_p sqrt(2/(9k)))^3 with z_p the normal quantile.
  const z = p === 0.995 ? Z_995 : p === 0.005 ? -Z_995 : (() => { throw new Error('only the 0.995 and 0.005 quantiles are tabulated'); })();
  const c = 2 / (9 * dof);
  return dof * (1 - c + z * Math.sqrt(c)) ** 3;
};
// Two-sided 99 % interval of the mean NEES over `epochs` independent epochs of a 6-dimensional state.
export const meanNeesInterval = (epochs, dim = 6) => [chiSquareQuantile(epochs * dim, 0.005) / epochs, chiSquareQuantile(epochs * dim, 0.995) / epochs];

// ---- statistics over histories ----
export const mean = (a) => a.reduce((s, x) => s + x, 0) / Math.max(1, a.length);
export const norm3 = (a, offset = 0) => Math.hypot(a[offset], a[offset + 1], a[offset + 2]);

// NEES series of a filtered history against the truth states (aligned by index).
export function neesSeries(history, truth) {
  return history.map((h, k) => quadraticForm(h.filteredCovariance, h.filteredState.map((x, i) => x - truth[k][i])));
}
// Mean NEES over [from, to) and the share of consecutive `window`-epoch windows
// of that segment whose mean lies inside the two-sided 99 % interval for the window.
export function neesSegment(series, from, to, window = 60) {
  const values = series.slice(from, to), [lo, hi] = meanNeesInterval(window);
  let inside = 0, windows = 0;
  for (let at = 0; at + window <= values.length; at += window) { const m = mean(values.slice(at, at + window)); windows += 1; if (m >= lo && m <= hi) inside += 1; }
  return { mean: mean(values), windows, inside, fraction: windows ? inside / windows : NaN, interval: [lo, hi] };
}

// Seconds after the arc epoch of a module epoch { jdDay, seconds }.
export const secondsSince = (epoch, jd0) => (epoch.jdDay - jd0) * 86400 + epoch.seconds;
