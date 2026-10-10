// Seeded assignment problems of the sizes OR-Library publishes (100 and 200
// dense, 800 sparse), and an independent exact solver for their optimal values.
//
// OR-Library's files (Beasley) carry no licence, so none is kept here. What the
// test needs from them is a problem whose optimum is known without the module:
// here the optimum comes from a textbook O(n^3) Hungarian method written
// below (potentials and augmenting paths, after Kuhn and Munkres), which shares
// no code with the module's solver. Costs are integers, so optima are exact.

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// n x n integer costs in [0, 99].
export function denseProblem(n, seed) {
  const r = mulberry32(seed);
  return Array.from({ length: n }, () => Array.from({ length: n }, () => Math.floor(r() * 100)));
}

// n x n with `perRow` permitted columns per row, one of them on a hidden
// permutation, so a perfect matching exists. Entries are [row, column, cost].
export function sparseProblem(n, seed, perRow = 6) {
  const r = mulberry32(seed);
  const hidden = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [hidden[i], hidden[j]] = [hidden[j], hidden[i]]; }
  const entries = [];
  for (let i = 0; i < n; i++) {
    const columns = new Set([hidden[i]]);
    while (columns.size < perRow) columns.add(Math.floor(r() * n));
    for (const j of [...columns].sort((a, b) => a - b)) entries.push([i, j, 1 + Math.floor(r() * 99)]);
  }
  return { rows: n, columns: n, entries };
}

// Minimum total cost of a perfect assignment of a dense square matrix.
export function hungarianOptimum(cost) {
  const n = cost.length, INF = Infinity;
  const u = new Array(n + 1).fill(0), v = new Array(n + 1).fill(0), p = new Array(n + 1).fill(0), way = new Array(n + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array(n + 1).fill(INF), used = new Array(n + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = INF, j1 = 0;
      for (let j = 1; j <= n; j++) if (!used[j]) {
        const cur = cost[i0 - 1][j - 1] - u[i0] - v[j];
        if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
        if (minv[j] < delta) { delta = minv[j]; j1 = j; }
      }
      for (let j = 0; j <= n; j++) if (used[j]) { u[p[j]] += delta; v[j] -= delta; } else minv[j] -= delta;
      j0 = j1;
    } while (p[j0] !== 0);
    do { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1; } while (j0);
  }
  let total = 0;
  for (let j = 1; j <= n; j++) total += cost[p[j] - 1][j - 1];
  return total;
}

// The optimum of a sparse problem: absent pairs cost more than any assignment
// of permitted ones, so a perfect matching of permitted pairs is optimal if one
// exists (it does by construction); the result is checked for that.
export function sparseOptimum({ rows: n, entries }) {
  const forbidden = 100 * n + 1;
  const cost = Array.from({ length: n }, () => new Array(n).fill(forbidden));
  for (const [i, j, c] of entries) cost[i][j] = c;
  const total = hungarianOptimum(cost);
  if (total >= forbidden) throw new Error('no perfect matching of permitted pairs');
  return total;
}
