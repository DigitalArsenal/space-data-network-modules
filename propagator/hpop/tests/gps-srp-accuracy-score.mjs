// Scores the GPS radiation-pressure experiment: 3D (and R, T, N) position
// error of each variant against the ESA final reference states, medians and
// 95th percentiles with E3's two-way (object x day) pigeonhole bootstrap
// (2000 resamples, seed 20261009, 95 %), and paired ratios of medians.
// Bookkeeping and statistics only.
//   node tests/gps-srp-accuracy-score.mjs <out dir> [E3 samples.jsonl.gz for the HPOP-URA cross-check]
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const [dir, e3Samples] = process.argv.slice(2);
const { jobs } = JSON.parse(fs.readFileSync(path.join(dir, 'jobs.json'), 'utf8'));
const byId = new Map(jobs.map((j) => [j.id, j]));
const results = new Map();  // `${id}|${variant}` -> [positions]
const fits = new Map();
const errors = [];
for (const f of fs.readdirSync(dir).filter((f) => /^out.*\.txt$/.test(f))) {
  for (const l of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
    const w = l.split(' ');
    if (w[0] === 'res') { const k = `${w[1]}|${w[2]}`; if (!results.has(k)) results.set(k, []); results.get(k)[Number(w[3])] = w.slice(4, 7).map(Number); }
    if (w[0] === 'fit') fits.set(`${w[1]}|${w[2]}`, { iterations: Number(w[3]), rmsM: Number(w[4]), parameters: w.slice(5).map(Number) });
    if (w[0] === 'error') errors.push(l);
  }
}
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a) => { const n = Math.hypot(...a); return a.map((x) => x / n); };
const rtn = (p, ref) => { const R = unit(ref.r), N = unit(cross(ref.r, ref.v)), T = cross(N, R), d = sub(p, ref.r); return [dot(d, R), dot(d, T), dot(d, N)]; };

const variants = [...new Set([...results.keys()].map((k) => k.split('|')[1]))].sort();
const samples = [];
for (const [k, positions] of results) {
  const [id, variant] = k.split('|'), job = byId.get(id);
  job.targets.forEach((t, i) => { if (positions[i]) samples.push({ id, norad: job.norad, day: job.T.slice(0, 10), block: job.block, h: t.h, variant, e: rtn(positions[i], t) }); });
}
// WASM (E3's request through the module) against native variant A.
let wasmCheck = null;
if (fs.existsSync(path.join(dir, 'wasm.json'))) {
  const wasm = JSON.parse(fs.readFileSync(path.join(dir, 'wasm.json'), 'utf8'));
  let worst = 0, n = 0;
  for (const r of wasm.results) {
    const a = results.get(`${r.id}|A`); if (!a) continue;
    r.positions.forEach((p, i) => { worst = Math.max(worst, Math.hypot(...sub(p, a[i]))); ++n; });
  }
  wasmCheck = { wasmSha256: wasm.wasmSha256, compared: n, largestDifferenceM: worst * 1e3 };
}
// E3's own HPOP-URA errors (published run) against variant A.
let e3Check = null;
if (e3Samples) {
  const rows = zlib.gunzipSync(fs.readFileSync(e3Samples)).toString().split('\n').filter((l) => l.includes('"HPOP-URA"')).map((l) => JSON.parse(l)).filter((s) => s.error);
  let worst = 0, n = 0;
  for (const s of rows) {
    const id = `${s.norad}_${s.T.slice(0, 10)}`;
    const mine = samples.find((x) => x.id === id && x.variant === 'A' && x.h === s.h);
    if (!mine) continue;
    worst = Math.max(worst, Math.hypot(...sub(mine.e, s.error))); ++n;
  }
  e3Check = { e3Samples: rows.length, compared: n, largestDifferenceM: worst * 1e3 };
}

// ── Statistics (E3 20-evaluate.mjs) ──
function rng(seed) { let s = seed >>> 0; return () => { s = (s + 0x9e3779b9) >>> 0; let z = s; z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0; z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0; return ((z ^ (z >>> 16)) >>> 0) / 4294967296; }; }
function quantile(xs, q) { const s = [...xs].sort((a, b) => a - b); if (!s.length) return NaN; const h = (s.length - 1) * q, lo = Math.floor(h), hi = Math.ceil(h); return s[lo] + (s[hi] - s[lo]) * (h - lo); }
function weightedQuantile(pairs, q) { const total = pairs.reduce((t, p) => t + p[1], 0); let acc = 0; for (const [v, w] of pairs) { acc += w; if (acc >= q * total) return v; } return pairs.at(-1)?.[0] ?? NaN; }
function bootstrap(cells, statistic, seed, resamples = 2000) {
  const rows = [...new Set(cells.map((c) => c.row))], cols = [...new Set(cells.map((c) => c.col))];
  const random = rng(seed);
  const draw = (keys) => { const m = new Map(keys.map((k) => [k, 0])); for (let i = 0; i < keys.length; ++i) { const k = keys[Math.floor(random() * keys.length)]; m.set(k, m.get(k) + 1); } return m; };
  const xs = [];
  for (let b = 0; b < resamples; ++b) {
    const r = draw(rows), c = draw(cols);
    const w = cells.map((cell) => ({ ...cell, weight: r.get(cell.row) * c.get(cell.col) })).filter((x) => x.weight);
    const v = statistic(w); if (Number.isFinite(v)) xs.push(v);
  }
  return { estimate: statistic(cells.map((x) => ({ ...x, weight: 1 }))), lower: quantile(xs, 0.025), upper: quantile(xs, 0.975) };
}
const qStat = (q) => (cells) => weightedQuantile(cells.flatMap((c) => c.values.map((v) => [v, c.weight])).sort((a, b) => a[0] - b[0]), q);
const cellsOf = (list) => { const m = new Map(); for (const s of list) { const k = `${s.norad}|${s.day}`; if (!m.has(k)) m.set(k, { row: s.norad, col: s.day, values: [] }); m.get(k).values.push(Math.hypot(...s.e)); } return [...m.values()]; };
function pairedRatio(list, a, b, seed) {
  const m = new Map();
  const by = new Map(); for (const s of list) { const k = `${s.id}|${s.h}`; if (!by.has(k)) by.set(k, {}); by.get(k)[s.variant] = s; }
  for (const p of by.values()) {
    if (!p[a] || !p[b]) continue;
    const k = `${p[a].norad}|${p[a].day}`; if (!m.has(k)) m.set(k, { row: p[a].norad, col: p[a].day, a: [], b: [] });
    m.get(k).a.push(Math.hypot(...p[a].e)); m.get(k).b.push(Math.hypot(...p[b].e));
  }
  const stat = (cells) => weightedQuantile(cells.flatMap((c) => c.a.map((v) => [v, c.weight])).sort((x, y) => x[0] - y[0]), 0.5) / weightedQuantile(cells.flatMap((c) => c.b.map((v) => [v, c.weight])).sort((x, y) => x[0] - y[0]), 0.5);
  return bootstrap([...m.values()], stat, seed);
}
const groups = [['all', () => true], ['IIR/IIR-M', (s) => s.block === 'IIR' || s.block === 'IIR-M'], ['IIF', (s) => s.block === 'IIF'], ['III', (s) => s.block === 'III']];
const horizons = [...new Set(samples.map((s) => s.h))].sort((a, b) => a - b);
const table = [];
let seed = 20261009;
for (const [g, keep] of groups) for (const h of horizons) for (const v of variants) {
  const list = samples.filter((s) => s.variant === v && s.h === h && keep(s));
  if (!list.length) continue;
  const cells = cellsOf(list);
  const sq = [0, 1, 2].map((a) => Math.sqrt(list.reduce((t, s) => t + s.e[a] ** 2, 0) / list.length));
  table.push({ group: g, h, variant: v, n: list.length, median: bootstrap(cells, qStat(0.5), seed++), p95: bootstrap(cells, qStat(0.95), seed++), rmsRtnKm: sq });
}
const ratios = [];
for (const [g, keep] of groups) for (const h of horizons) for (const [a, b] of [['B', 'A'], ['C', 'A'], ['D', 'A'], ['E', 'A'], ['D', 'C'], ['D', 'E']]) {
  if (!variants.includes(a) || !variants.includes(b)) continue;
  const list = samples.filter((s) => s.h === h && keep(s));
  ratios.push({ group: g, h, ratio: `${a}/${b}`, ...pairedRatio(list, a, b, seed++) });
}
const fitSummary = {};
for (const v of variants) {
  const f = [...fits].filter(([k]) => k.endsWith(`|${v}`)).map(([, x]) => x).filter((x) => x.iterations > 0);
  if (f.length) fitSummary[v] = { n: f.length, medianRmsM: quantile(f.map((x) => x.rmsM), 0.5), p95RmsM: quantile(f.map((x) => x.rmsM), 0.95), medianIterations: quantile(f.map((x) => x.iterations), 0.5) };
}
const out = { jobs: jobs.length, samples: samples.length, errors: errors.length, errorLines: errors.slice(0, 5), wasmCheck, e3Check, fitSummary, table, ratios };
fs.writeFileSync(path.join(dir, 'score.json'), JSON.stringify(out, null, 1));
const m = (x) => (x * 1e3 < 1000 ? `${(x * 1e3).toFixed(1)} m` : `${x.toFixed(2)} km`);
const ci = (b) => `${m(b.estimate)} [${m(b.lower)}, ${m(b.upper)}]`;
console.log(JSON.stringify({ jobs: out.jobs, samples: out.samples, errors: out.errors, wasmCheck, e3Check, fitSummary }, null, 1));
for (const r of table) console.log(`${r.group.padEnd(9)} ${r.h}d ${r.variant} n=${r.n} median ${ci(r.median)}  p95 ${ci(r.p95)}  rmsRTN ${r.rmsRtnKm.map((x) => (x * 1e3).toFixed(1)).join('/')} m`);
for (const r of ratios) console.log(`${r.group.padEnd(9)} ${r.h}d ${r.ratio} ${r.estimate.toFixed(3)} [${r.lower.toFixed(3)}, ${r.upper.toFixed(3)}]`);
