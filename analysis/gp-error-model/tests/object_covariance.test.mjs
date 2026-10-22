// Independent arithmetic oracle: common_epoch (python-sgp4/pyerfa verified in
// stm-reference.json) supplies SGP4 residuals and GCRF states, never this method.
// UTC, 2006-06-25 onward; internal RTN km/km/s, outputs SI m/m/s. Relative 1e-9
// allows roundoff from taking RTN differences before vs after the GCRF rotation;
// symmetry is exact. These synthetic element histories are not truth data.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { call, invoke, json, frame, modelsFrame, outputs } from './erm-harness.mjs';
import { encodeOmm, ommFrame, valladoOmm, kc, beyond, flatbuffers } from './products-fixtures.mjs';

const require = createRequire(import.meta.url);
const root = path.dirname(require.resolve('spacedatastandards.org/package.json'));
const E = await import(pathToFileURL(path.join(root, 'lib/js/ERM/main.js')));
const raw = (b) => E.ERM.getSizePrefixedRootAsERM(new flatbuffers.ByteBuffer(b)).unpack();
const seed = { ...valladoOmm(6251), norad: 6251 };
let randomState = 0x62512020;
const random = () => { randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0; return randomState / 2 ** 32 - 0.5; };
let hours = 0;
// 73 sets over exactly 30 days, 6..14 h spacing. Perturb only the documented
// Vallado verification fixture's n, B*, and M, advancing M at the seed's n.
const history = Array.from({ length: 73 }, (_, i) => {
  if (i) hours += 6 + (i - 1) % 9;
  return { ...seed, epoch: new Date(Date.parse(seed.epoch + 'Z') + hours * 3600000).toISOString(),
    n: seed.n + random() * 0.0002, bstar: seed.bstar * (1 + 0.4 * random()),
    m: (seed.m + seed.n * 360 * hours / 24 + random() * 0.04 + (i === 50 ? 145 : 0)) % 360 };
});
const anchor = history.at(-1), regimeIndex = 0;
const elements = (sets) => ommFrame('elements', Buffer.concat(sets.map((s) => encodeOmm(s))));
const request = (ageDays, s = anchor, id = 'object') => ({ id, set: { norad: s.norad, epoch: s.epoch }, ageDays });
const cfg = (c) => Object.fromEntries(Object.entries(c).map(([k, v]) => ['object.' + k, v]));
async function run(sets, ages, { model = kc, config = {}, requests, extra = [] } = {}) {
  const r = await invoke('object_covariance', [elements(sets), ...(model ? [modelsFrame(Array.isArray(model) ? model : [model])] : []),
    json('request', { objects: requests ?? ages.map((a) => request(a)) }), ...extra], { config: cfg(config) });
  assert.equal(r.statusCode, 0, r.errorMessage);
  return { ...outputs(r), rawReport: raw(r.outputs.find((f) => f.portId === 'report').payload).ATTACH_REPORT };
}
const lower = (m) => { const a = []; for (let i = 0; i < 6; i++) for (let j = 0; j <= i; j++) a.push(m[6 * i + j]); return a; };
const full = (a) => { const m = Array(36).fill(0); for (let i = 0, k = 0; i < 6; i++) for (let j = 0; j <= i; j++, k++) m[6 * i + j] = m[6 * j + i] = a[k]; return m; };
function close(a, b, tolerance = 1e-9) {
  assert.equal(a.length, b.length);
  a.forEach((x, i) => assert.ok(Number.isFinite(x) && Math.abs(x - b[i]) <= tolerance * Math.max(1e-12, Math.abs(b[i])), `${i}: ${x} vs ${b[i]}`));
}
const binOf = (age, model = kc) => model.ageBinsDays.findIndex(([a, b], i) => age >= a && (age < b || i === model.ageBinsDays.length - 1 && age === b));
const histogramBin = (x) => Math.abs(x) < 1e-9 ? 0 : Math.sign(x) * Math.min(280, Math.floor((Math.log10(Math.abs(x)) + 9) * 20) + 1);
function quantile(hist, n, p) {
  let cumulative = 0;
  for (const [key, count] of Object.entries(hist).map(([k, n]) => [+k, n]).sort((a, b) => a[0] - b[0])) {
    if (cumulative + count >= p * n) {
      if (!key) return 0;
      const lo = 10 ** ((Math.abs(key) - 1) / 20 - 9), hi = 10 ** (Math.abs(key) / 20 - 9);
      return (key > 0 ? lo : -hi) + (p * n - cumulative) / count * (hi - lo);
    }
    cumulative += count;
  }
  throw new Error('empty histogram');
}
function moments(pairs) {
  const sum = Array(6).fill(0), sq = Array(21).fill(0), hist = Array.from({ length: 6 }, () => ({}));
  for (const { x } of pairs) {
    for (let i = 0, k = 0; i < 6; i++) {
      sum[i] += x[i]; const bin = histogramBin(x[i]); hist[i][bin] = (hist[i][bin] ?? 0) + 1;
      for (let j = 0; j <= i; j++, k++) sq[k] += x[i] * x[j];
    }
  }
  return { n: pairs.length, sum, sq, hist };
}
async function historyOracle(sets) {
  const targets = sets.slice(1).map((s, k) => ({ norad: s.norad, epoch: s.epoch, origin: 'set', originSet: s.epoch,
    sets: sets.slice(0, k + 1).filter((j) => (Date.parse(s.epoch) - Date.parse(j.epoch)) / 86400000 < 8).map((j) => j.epoch) }));
  const result = await call('common_epoch', [elements(sets), json('options', { targets })]);
  const bins = kc.ageBinsDays.map(() => []);
  for (const t of result.targets) for (const s of t.sets) bins[binOf(s.ageDays)].push({ older: s.epoch, x: s.rtn });
  const stats = bins.map((pairs) => {
    const a = moments(pairs);
    if (!pairs.length) return { ...a, center: Array(6).fill(0), sigma: Array(6).fill(0), clipped: a, sets: 0, moment: Array(21).fill(0) };
    const center = a.hist.map((h) => quantile(h, a.n, 0.5));
    const sigma = a.hist.map((h) => (quantile(h, a.n, 0.841345) - quantile(h, a.n, 0.158655)) / 2);
    const kept = pairs.filter(({ x }) => [0, 1, 2].every((i) => Math.abs(x[i] - center[i]) <= 5 * sigma[i]));
    const clipped = moments(kept);
    return { ...a, center, sigma, clipped, sets: new Set(kept.map((p) => p.older)).size,
      moment: clipped.sq.map((x) => x / clipped.n) };
  });
  return { stats, bins };
}
let oraclePromise;
function oracle() { return oraclePromise ??= historyOracle(history); }
function interpolate(values, age, model = kc) {
  const have = values.map((v, i) => v ? i : -1).filter((i) => i >= 0);
  const center = (i) => (model.ageBinsDays[i][0] + model.ageBinsDays[i][1]) / 2;
  if (age <= center(have[0])) return values[have[0]];
  if (age >= center(have.at(-1))) return values[have.at(-1)];
  for (let k = 0; k < have.length - 1; k++) {
    const [i, j] = [have[k], have[k + 1]];
    if (age >= center(i) && age <= center(j)) {
      const f = (age - center(i)) / (center(j) - center(i));
      return values[i].map((x, c) => (1 - f) * x + f * values[j][c]);
    }
  }
}
function expected(stats, age, model = kc, threshold = 12, shrinkage = 30) {
  const weights = [], mixed = [], population = [];
  for (let i = 0; i < stats.length; i++) {
    const cell = model.strata.find((s) => s.regimeIndex === regimeIndex && s.ageIndex === i && s.n >= (model.minimumBinSamples ?? 0));
    if (!cell) continue;
    const f = model.factors?.find((s) => s.regimeIndex === regimeIndex && s.ageIndex === i)?.factor ?? 1;
    const w = stats[i].sets >= threshold ? stats[i].sets / (stats[i].sets + shrinkage) : 0;
    weights[i] = [w]; population[i] = cell.covariance.map((x) => x * f);
    mixed[i] = cell.covariance.map((x, k) => w * stats[i].moment[k] + (1 - w) * x * f);
  }
  return { covariance: interpolate(mixed, age, model).map((x) => x * 1e6), weight: interpolate(weights, age, model)[0], population };
}
async function stateAt(s, age) {
  const epoch = new Date(Date.parse(s.epoch) + age * 86400000).toISOString();
  const out = await call('common_epoch', [elements([s]), json('options', { targets: [{ norad: s.norad, epoch, origin: 'set', originSet: s.epoch, sets: [s.epoch] }] })]);
  const state = out.targets[0].state.map((x) => x * 1000);
  return { position: state.slice(0, 3), velocity: state.slice(3) };
}
async function populationOracle(s, age, model = kc) {
  return (await call('calibrate_covariance', [elements([s]), json('model', model), json('objects', { objects: [{ ...request(age, s), state: await stateAt(s, age) }] })])).objects[0];
}
// Jacobi eigenvalues of a symmetric matrix, used on a diagonally normalized
// covariance so mixed position/velocity units do not hide a negative direction.
function eigenvalues(m) {
  const a = [...m];
  for (let iter = 0; iter < 200; iter++) {
    let p = 0, q = 1;
    for (let i = 0; i < 6; i++) for (let j = i + 1; j < 6; j++) if (Math.abs(a[6*i+j]) > Math.abs(a[6*p+q])) [p,q] = [i,j];
    if (Math.abs(a[6*p+q]) < 1e-13) break;
    const angle = 0.5 * Math.atan2(2*a[6*p+q], a[6*q+q]-a[6*p+p]);
    const c = Math.cos(angle), s = Math.sin(angle);
    for (let k = 0; k < 6; k++) { const x=a[6*k+p], y=a[6*k+q]; a[6*k+p]=c*x-s*y; a[6*k+q]=s*x+c*y; }
    for (let k = 0; k < 6; k++) { const x=a[6*p+k], y=a[6*q+k]; a[6*p+k]=c*x-s*y; a[6*q+k]=s*x+c*y; }
  }
  return Array.from({ length:6 }, (_,i)=>a[7*i]);
}

test('history covariance: common_epoch residual oracle, finalize clipping, shrinkage and GCRF rotation', async () => {
  const { stats } = await oracle();
  // finalize independently reads the oracle's sufficient statistics and signed
  // histograms; its quantiles must agree, including the designed outlier removal.
  const finalized = await call('finalize', [json('accumulator', { kind: 'gp-error-accumulator', version: 1, mode: 'gp-differences',
    regimes: kc.regimes, ageBinsDays: kc.ageBinsDays, clipK: 5, counts: {},
    strata: stats.map((s, age) => ({ regime: 0, age, n: s.n, sum: s.sum, sq: s.sq, hist: s.hist, clip: s.clipped })) })]);
  for (const s of finalized.strata) {
    const b = stats[s.ageIndex]; close(s.median, b.center, 1e-12); close(s.robustSigma, b.sigma, 1e-12);
    assert.equal(s.clipped.n, b.clipped.n);
    const reconstructed = s.clipped.covariance.map((x, k) => {
      let i = 0; while ((i + 1) * (i + 2) / 2 <= k) i++;
      const j = k - i * (i + 1) / 2;
      return x * (s.clipped.n - 1) / s.clipped.n + s.clipped.mean[i] * s.clipped.mean[j];
    });
    close(reconstructed, b.moment, 1e-10);
  }
  assert.ok(stats.some((s) => s.clipped.n < s.n), 'the outlier exercises clipping');
  const ages = [0.25, 0.5, 0.8, 1.125, 2, 3, 5, 7];
  const got = await run(history, ages);
  assert.equal(got.covariance.rule, 'empirical-history-shrunk');
  assert.equal(got.covariance.calibrationVersion, '0.8.0:' + kc.id);
  for (let i = 0; i < ages.length; i++) {
    const age = ages[i], row = got.covariance.objects[i], label = got.report.objects[i].rows[0], bin = binOf(age);
    assert.equal(row.status, 'EMPIRICAL');
    const want = expected(stats, age); close(row.covarianceRtn, want.covariance);
    close([label.scaleFactor], [want.weight], 1e-12);
    assert.equal(label.samples, stats[bin].clipped.n); assert.equal(label.objects, stats[bin].sets);
    assert.equal(label.rule, 2); assert.equal(label.calibration, 'UNCALIBRATED');
    assert.equal(got.report.objects[i].calibrated, false);
    const cvr = got.rawReport.OBJECTS[i].ROWS[0].REALISM;
    assert.ok(Number.isNaN(cvr.MEAN_D2_OVER_3) && Number.isNaN(cvr.COVERAGE_95)); assert.ok(!cvr.TEST_WINDOW);
    // Independent rotation path: factor-one calibrate_covariance, on the same
    // SGP4 GCRF state, with the TEST's empirical matrix in SI as native covariance.
    const rotation = await call('calibrate_covariance', [json('model', { kind: 'e14-factors', version: 'rotation', regimes: kc.regimes,
      strata: [{ regime: 'LEO-L', horizonDays: [0, 9], factor: 1 }] }), json('objects', { objects: [{ id: 'rotation', regime: 'LEO-L',
      horizonDays: age, covariance: want.covariance, state: await stateAt(anchor, age) }] })]);
    close(row.covarianceInertial, rotation.objects[0].covarianceInertial);
    const m = row.covarianceInertial;
    for (let r = 0; r < 6; r++) for (let c = 0; c < 6; c++) assert.equal(m[6*r+c], m[6*c+r]);
  }
});

test('three older sets: bit-identical population fallback, zero weight and reasons', async () => {
  const short = history.slice(-4), ages = [0, 0.8, 7.9, 8];
  const got = await run(short, ages);
  for (let i = 0; i < ages.length; i++) {
    const want = await populationOracle(anchor, ages[i]);
    const row = got.covariance.objects[i];
    assert.equal(row.status, 'POPULATION'); assert.deepEqual(row.covarianceRtn, want.covarianceRtn);
    close(row.covarianceInertial, want.covarianceInertial, 1e-12);
    assert.equal(got.report.objects[i].rows[0].scaleFactor, 0);
    assert.ok(got.report.objects[i].notes.some((n) => /too few older sets/.test(n.reason)));
  }
});

test('bin threshold, zero shrinkage, large sample weight and PSD convex combination', async () => {
  const { stats } = await oracle(), age = 2, b = binOf(age), n = stats[b].sets;
  const below = await run(history, [age], { config: { minimumBinSets: n + 1 } });
  assert.equal(below.covariance.objects[0].status, 'POPULATION');
  assert.deepEqual(below.covariance.objects[0].covarianceRtn, (await populationOracle(anchor, age)).covarianceRtn);
  assert.equal(below.report.objects[0].rows[0].scaleFactor, 0);
  const at = await run(history, [age], { config: { minimumBinSets: n } });
  assert.equal(at.covariance.objects[0].status, 'EMPIRICAL');
  close([at.report.objects[0].rows[0].scaleFactor], [n / (n + 30)], 1e-12);
  const m = full(at.covariance.objects[0].covarianceRtn), em = stats[b].moment.map((x) => x * 1e6);
  const pop = expected(stats, age).population[b].map((x) => x * 1e6);
  at.covariance.objects[0].covarianceRtn.forEach((x, k) => assert.ok(x >= Math.min(em[k], pop[k]) - 1e-6 && x <= Math.max(em[k], pop[k]) + 1e-6));
  const diagonal = Array.from({ length: 6 }, (_, i) => Math.sqrt(m[7*i]));
  assert.ok(eigenvalues(m.map((x, k) => x / diagonal[Math.floor(k/6)] / diagonal[k%6])).every((v) => v >= -1e-10));
  const noPrior = await run(history, [age], { config: { shrinkage: 0 } });
  close(noPrior.covariance.objects[0].covarianceRtn, em);
  assert.equal(noPrior.report.objects[0].rows[0].scaleFactor, 1);
});

test('causality, duplicate stream order, object isolation and request order', async () => {
  const base = await run(history, [2]);
  const future = { ...anchor, epoch: new Date(Date.parse(anchor.epoch) + 2000).toISOString(), m: anchor.m + 20 };
  const unrelated = history.map((s) => ({ ...s, norad: 123456, m: s.m + 10 }));
  const appended = await run([...history, future, ...unrelated], [2]);
  assert.deepEqual(appended.covariance, base.covariance); assert.deepEqual(appended.report, base.report);
  const shuffled = await run([...history].reverse(), [2]); assert.deepEqual(shuffled.covariance, base.covariance);
  const changed = await run(history.filter((_, i) => i !== 5), [2]);
  assert.notDeepEqual(changed.covariance.objects[0].covarianceRtn, base.covariance.objects[0].covarianceRtn);
  const duplicate = { ...history[5], m: history[5].m + 60 };
  const lastWins = await run([duplicate, ...history], [2]); assert.deepEqual(lastWins.covariance, base.covariance);
  const replaced = await run([...history, duplicate], [2]); assert.notDeepEqual(replaced.covariance, base.covariance);
  const ordered = await run([...history, ...unrelated], [], { requests: [request(2, unrelated.at(-1), 'second'), request(2, anchor, 'first')] });
  assert.deepEqual(ordered.covariance.objects.map((o) => o.id), ['second', 'first']);
  assert.deepEqual(ordered.report.objects.map((o) => o.object), ['second', 'first']);
  assert.deepEqual(ordered.covariance.objects[1].covarianceRtn, base.covariance.objects[0].covarianceRtn);
});

test('model selection, missing cells, unsupported regimes/ages and absent sets/models', async () => {
  const alternate = { ...kc, id: 'pooled-prior', pooled: true, strata: kc.strata.map((s) => ({ ...s, covariance: s.covariance.map((x) => 2*x) })) };
  const got = await run(history.slice(-4), [2], { model: [kc, alternate, { ...alternate, id: 'later' }] });
  assert.equal(got.covariance.calibrationVersion, '0.8.0:pooled-prior'); assert.equal(got.report.objects[0].rule, 4);
  assert.deepEqual(got.covariance.objects[0].covarianceRtn, (await populationOracle(anchor, 2, alternate)).covarianceRtn);
  const absent = await run(history, [2], { model: null }); assert.equal(absent.covariance.objects[0].status, 'NO_MODEL');
  assert.match(absent.rawReport.OBJECTS[0].NOTES[0].REASON, /no model/);
  const heo = { ...valladoOmm(9880), norad: 9880 };
  const refusals = await run([...history, beyond, heo], [], { requests: [request(8.001), request(2, beyond), request(2, heo), request(2, { ...anchor, norad: 999999 })] });
  assert.deepEqual(refusals.covariance.objects.map((o) => o.status), ['OUTSIDE', 'OUTSIDE', 'NO_MODEL', 'NO_SET']);
  refusals.covariance.objects.forEach((o) => assert.equal(o.covarianceRtn, undefined));
  const sparse = { ...kc, strata: kc.strata.filter((s) => s.ageIndex !== 3) };
  const missing = await run(history, [2], { model: sparse });
  assert.equal(missing.covariance.objects[0].status, 'POPULATION');
  assert.deepEqual(missing.covariance.objects[0].covarianceRtn, (await populationOracle(anchor, 2, sparse)).covarianceRtn);
});

test('population verdict computed from numbers, and ignored request fields', async () => {
  const model = { ...kc, cells: kc.cells.map((s) => ({ ...s, meanD2Over3: 1, coverage95: 0.95, samples: 30, objects: 3, decision: 'FAILED' })) };
  const result = await run(history.slice(-4), [2], { model }); assert.equal(result.report.objects[0].calibrated, true);
  const failed = await run(history.slice(-4), [2], { model: { ...model, cells: model.cells.map((s) => ({ ...s, coverage95: 0.8, decision: 'REALISTIC' })) } });
  assert.equal(failed.report.objects[0].calibrated, false);
  const ignored = await run(history, [], { requests: [{ ...request(2), regime: 'GEO', objectFactor: 99, horizonDays: 50,
    state: { position: [1,2,3], velocity: [4,5,6] }, covariance: [9,0,9,0,0,9] }] });
  assert.deepEqual(ignored.covariance, (await run(history, [2])).covariance);
});

test('config window and pair limit; 200 epoch cap', async () => {
  const limited = await run(history, [2], { config: { historyDays: 1 } }); assert.equal(limited.covariance.objects[0].status, 'POPULATION');
  const ageLimit = await run(history, [2], { config: { maxAgeDays: 1 } }); assert.equal(ageLimit.covariance.objects[0].status, 'POPULATION');
  const dense = Array.from({ length: 205 }, (_, i) => ({ ...anchor, epoch: new Date(Date.parse(anchor.epoch) - (204-i)*3*3600000).toISOString(), m: (anchor.m + i*7)%360 }));
  const capped = await run(dense, [2]); const exact = await run(dense.slice(-200), [2]);
  assert.deepEqual(capped.covariance, exact.covariance); assert.deepEqual(capped.report, exact.report);
});

test('typed contract: raw CVR, wrong arms, unknown ports, bad ages and config', async () => {
  const r = await run(history, [2]);
  assert.equal(r.rawReport.OBJECTS[0].ROWS[0].REALISM.CALIBRATION, E.covarianceCalibration.Uncalibrated);
  assert.equal(r.rawReport.OBJECTS[0].ROWS[0].REALISM.RULE, E.covarianceRule.ScaledFit);
  const valid = [elements(history), modelsFrame([kc]), json('request', { objects: [request(2)] })];
  const unknown = await invoke('object_covariance', [...valid, frame('unknown', 'objects', { objects: [] })]); assert.notEqual(unknown.statusCode, 0);
  const wrong = await invoke('object_covariance', [elements(history), modelsFrame([kc]), frame('request', 'model', kc)]); assert.notEqual(wrong.statusCode, 0);
  for (const age of [-1, Infinity, NaN]) {
    const bad = await invoke('object_covariance', [elements(history), modelsFrame([kc]), json('request', { objects: [request(age)] })]); assert.notEqual(bad.statusCode, 0);
  }
  const badConfig = await invoke('object_covariance', valid, { config: cfg({ shrinkage: -1 }) }); assert.notEqual(badConfig.statusCode, 0);
  assert.equal(JSON.parse(fs.readFileSync(new URL('../dist/plugin-manifest.json', import.meta.url))).version, '0.8.0');
});

test('varying cell factors: exact population fallback and independently scaled empirical bin priors', async () => {
  // Designed positive factors 1..7, independent of any new method output.
  // Epochs/units/tolerance as the oracle above; this exercises the distinction
  // between interpolate(C)*interpolate(f) and interpolate(C*f).
  const model = { ...kc, factors: kc.ageBinsDays.map((_, ageIndex) => ({ regimeIndex: 0, ageIndex, factor: ageIndex + 1 })) };
  const age = 0.8;
  const got = await run(history.slice(-4), [age], { model });
  const want = await populationOracle(anchor, age, model);
  assert.deepEqual(got.covariance.objects[0].covarianceRtn, want.covarianceRtn);
  assert.equal(got.covariance.objects[0].factor, want.factor);
  const empirical = await run(history, [age], { model });
  close(empirical.covariance.objects[0].covarianceRtn, expected((await oracle()).stats, age, model).covariance);
});

test('request/model streams preserve order; history window excludes old sets; empty first age bin falls back', async () => {
  const records = Buffer.concat([frame('request', 'objects', { objects: [request(0, anchor, 'zero')] }).payload,
    frame('request', 'objects', { objects: [request(2, anchor, 'two')] }).payload]);
  const response = await invoke('object_covariance', [elements(history), modelsFrame([kc]), { ...frame('request', 'objects', {}), payload: records }]);
  assert.equal(response.statusCode, 0, response.errorMessage);
  const got = outputs(response);
  assert.deepEqual(got.covariance.objects.map((o) => [o.id, o.status]), [['zero', 'POPULATION'], ['two', 'EMPIRICAL']]);
  assert.deepEqual(got.covariance.objects[0].covarianceRtn, (await populationOracle(anchor, 0)).covarianceRtn);
  const old = { ...history[0], epoch: new Date(Date.parse(history[0].epoch) - 3600000).toISOString(), m: 75 };
  assert.deepEqual((await run([old, ...history], [2])).covariance, (await run(history, [2])).covariance);
  const shortened = await run(history.slice(-10), [7]);
  assert.equal(shortened.covariance.objects[0].status, 'POPULATION');
  assert.ok(shortened.report.objects[0].notes.some((n) => /outside the history/.test(n.reason)));
});

test('millisecond republications preserve covariance and distinct older-set counts for either requested epoch', async () => {
  // Synthetic copies of the independently verified Vallado-derived history:
  // UTC epochs differ by exactly 1 ms; all mean elements are copied. The last
  // stream record must win, whether its epoch is earlier or later. Compare to
  // that retained history alone: changing the retained epoch itself changes
  // SGP4's input, so the two different retained histories are not bit oracles
  // for each other. RTN moments use common_epoch plus test arithmetic (1e-9
  // relative, km/km/s -> SI); duplicate invariance in both frames is bit-exact.
  const duplicates = history.map((s) => ({ ...s, epoch: new Date(Date.parse(s.epoch) + 1).toISOString() }));
  const ages = [0, 0.125, 0.5, 2, 7];
  for (const laterEpochWins of [false, true]) {
    const retained = laterEpochWins ? duplicates : history;
    const stream = history.flatMap((s, i) => laterEpochWins ? [s, duplicates[i]] : [duplicates[i], s]);
    const retainedAnchor = retained.at(-1);
    const { stats } = laterEpochWins ? await historyOracle(retained) : await oracle();
    const baseline = await run(retained, [], { requests: ages.map((age) => request(age, retainedAnchor)) });
    for (const namedAnchor of [anchor, duplicates.at(-1)]) {
      const got = await run(stream, [], { requests: ages.map((age) => request(age, namedAnchor)) });
      assert.deepEqual(got.covariance, baseline.covariance, 'both RTN and inertial matrices are bit-equal to the retained history');
      for (let i = 0; i < ages.length; i++) {
        const row = got.covariance.objects[i], label = got.report.objects[i].rows[0];
        const baseLabel = baseline.report.objects[i].rows[0], bin = binOf(ages[i]);
        assert.equal(label.samples ?? 0, stats[bin].clipped.n);
        assert.equal(label.objects ?? 0, stats[bin].sets);
        assert.equal(label.samples ?? 0, baseLabel.samples ?? 0);
        assert.equal(label.objects ?? 0, baseLabel.objects ?? 0);
        assert.equal(label.scaleFactor, baseLabel.scaleFactor);
        assert.equal(got.report.objects[i].epoch, namedAnchor.epoch, 'report echoes the requested epoch');
        if (ages[i] < 0.25) {
          assert.equal(row.status, 'POPULATION', 'republications must not make bin zero empirical');
          assert.deepEqual(row.covarianceRtn, (await populationOracle(retainedAnchor, ages[i])).covarianceRtn);
        } else {
          assert.equal(row.status, 'EMPIRICAL');
          close(row.covarianceRtn, expected(stats, ages[i]).covariance);
        }
      }
      // The overall count is not a wire field. Pin it via its gate: 73 retained
      // sets mean exactly 72 older sets, including when the stream has 146 rows.
      for (const minimumSets of [retained.length - 1, retained.length]) {
        const gated = await run(stream, [], { config: { minimumSets }, requests: [request(2, namedAnchor)] });
        assert.equal(gated.covariance.objects[0].status, minimumSets === retained.length - 1 ? 'EMPIRICAL' : 'POPULATION');
        assert.equal(gated.report.objects[0].notes.some((n) => /too few older sets/.test(n.reason)), minimumSets === retained.length);
      }
    }
  }
});

test('half-second request offsets resolve the retained set; two-second offsets are NO_SET', async () => {
  // Closed-form matching expectations from the standard absolute delta < 1 s
  // rule, in UTC. Both signs ensure matching is symmetric. The numerical oracle
  // remains common_epoch in RTN, km/km/s -> SI, at 1e-9 relative tolerance.
  const offsetsMs = [-2000, -1000, -500, 0, 500, 1000, 2000];
  const requests = offsetsMs.map((offset) => request(2,
    { ...anchor, epoch: new Date(Date.parse(anchor.epoch) + offset).toISOString() }, String(offset)));
  const got = await run(history, [], { requests });
  const { stats } = await oracle();
  const exact = got.covariance.objects[3];
  for (let i = 0; i < offsetsMs.length; i++) {
    const row = got.covariance.objects[i];
    if (Math.abs(offsetsMs[i]) < 1000) {
      assert.equal(row.status, 'EMPIRICAL');
      assert.deepEqual(row.covarianceRtn, exact.covarianceRtn);
      assert.deepEqual(row.covarianceInertial, exact.covarianceInertial);
      close(row.covarianceRtn, expected(stats, 2).covariance);
    } else {
      assert.equal(row.status, 'NO_SET');
      assert.equal(row.covarianceRtn, undefined);
      assert.equal(row.covarianceInertial, undefined);
    }
  }
});
