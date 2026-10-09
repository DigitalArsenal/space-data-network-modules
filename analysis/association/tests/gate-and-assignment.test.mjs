import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import test from 'node:test';
import { associate, block, celestial, diagonal, earthOrientation, eopRow, options, predictions, rdo, solveAssignment, OEM } from './lib.mjs';

const fixture = (name) => new URL(`./fixtures/${name}`, import.meta.url);

// A geocentric observer (sensor at the origin of GCRF) ranging objects that
// sit still on the +x axis: range is x, H = [1 0 0 0 0 0], so
// S = sigma^2 + P_xx exactly and d2 = (z - x)^2 / S. Units km.
const T0 = '2026-08-02T00:00:00Z', T1 = '2026-08-02T00:10:00Z', T = '2026-08-02T00:05:00Z';
const still = (x) => [{ epoch: T0, state: [x, 0, 0, 0, 0, 0] }, { epoch: T1, state: [x, 0, 0, 0, 0, 0] }];
const covs = (lower) => [{ epoch: T0, lower }, { epoch: T1, lower }];
const range = (id, km, time = T) => rdo({ ID: id, OB_TIME: time, ID_SENSOR: 'geocentre', SEN_REFERENCE_FRAME: 'GCRF', RANGE: km, RANGE_UNC: 0.001 });

test('chi-square gates match the NIST critical values for 1 to 6 degrees of freedom', async () => {
  // Source: NIST/SEMATECH e-Handbook 1.3.6.7.4 (fixture). Tolerance 5e-4:
  // half a unit in the third decimal the table prints.
  const nist = JSON.parse(fs.readFileSync(fixture('nist-chi-square.json'), 'utf8'));
  for (const [k, p] of nist.probabilities.entries()) {
    const { report } = await associate([
      predictions([block({ norad: 1, objectId: 'A', states: still(7000), covariances: covs(diagonal(1e-8)) })]),
      range('o', 7000), options({ gate_probability: p, light_time: false }),
    ]);
    for (let dof = 1; dof <= 6; dof++) {
      const expected = nist.criticalValues[dof][k];
      assert.ok(Math.abs(report.gate_thresholds[dof] - expected) <= 5e-4, `P=${p}, dof ${dof}: ${report.gate_thresholds[dof]} vs NIST ${expected}`);
    }
  }
});

test('OR-Library assignment problems solve to their published optimal values', async () => {
  // Beasley, OR-Library (fixtures/or-library/SOURCE.md): assign100 = 305,
  // assign200 = 475 (dense), assignp800 = 2239 (sparse; absent pairs are
  // forbidden). Integer costs: the optimum is exact.
  const optimal = Object.fromEntries(fs.readFileSync(fixture('or-library/assignopt.txt'), 'utf8').split('\n')
    .map((l) => l.trim().split(/\s+/)).filter((f) => f.length === 2 && /^assign/.test(f[0])).map(([k, v]) => [k, Number(v)]));
  for (const name of ['assign100', 'assign200']) {
    const numbers = fs.readFileSync(fixture(`or-library/${name}.txt`), 'utf8').trim().split(/\s+/).map(Number);
    const n = numbers[0];
    const cost = Array.from({ length: n }, (_, i) => numbers.slice(1 + i * n, 1 + (i + 1) * n));
    const solution = await solveAssignment({ cost });
    assert.equal(solution.total_cost, optimal[name], name);
    assert.equal(new Set(solution.assignment).size, n, `${name}: a permutation`);
    assert.equal(solution.assignment.reduce((s, j, i) => s + cost[i][j], 0), optimal[name], `${name}: the assignment costs what it reports`);
  }
  const sparse = zlib.gunzipSync(fs.readFileSync(fixture('or-library/assignp800.txt.gz'))).toString().trim().split('\n');
  const n = Number(sparse[0]);
  const entries = sparse.slice(1).map((l) => l.trim().split(/\s+/).map(Number)).map(([i, j, c]) => [i - 1, j - 1, c]);
  const solution = await solveAssignment({ rows: n, columns: n, entries });
  assert.equal(solution.total_cost, optimal.assignp800);
  const permitted = new Map(entries.map(([i, j, c]) => [`${i},${j}`, c]));
  assert.ok(solution.assignment.every((j, i) => permitted.has(`${i},${j}`)), 'only permitted pairs');
});

test('global assignment beats nearest neighbour, and ambiguity and posterior follow the likelihoods', async () => {
  // Object A sits at x = 7000 km. Object B is at 7000.003 km from the
  // origin along u = (1, 1, 0)/sqrt(2), moving along (-1, 1, 0)/sqrt(2), with
  // its covariance in RSW_INERTIAL: 1e-8 km^2 radial (along u), 1e-2 km^2
  // along-track and cross-track. The range Jacobian is u, so S = 1e-6 +
  // 1e-8 km^2 only if the RSW covariance is rotated correctly (read as GCRF
  // axes it would give 1e-6 + (1e-8 + 1e-2)/2). A has P = 1e-8 km^2 I, so
  // S = 1e-6 + 1e-8 km^2 for both (sigma = 1 m). The observations are at
  // the first sample epoch.
  // o1 at 7000.0014 km: d2 = 1.96/1.01 to A, 2.56/1.01 to B (its nearest is A).
  // o2 at 6999.9995 km: d2 = 0.25/1.01 to A, 12.25/1.01 to B (outside the
  // 1-dof gate 9.0 at P = 0.9973).
  // Exhaustive enumeration of the scan's assignments (with "unassigned" at
  // the gate) gives o1 -> B, o2 -> A at 2.81/1.01; nearest-neighbour order
  // would give o1 -> A and leave o2 a UCT (1.96/1.01 + 9.0).
  const h = Math.SQRT1_2, rb = 7000.003;
  const bStates = [{ epoch: T0, state: [rb * h, rb * h, 0, -7 * h, 7 * h, 0] }, { epoch: T1, state: [rb * h - 600 * 7 * h, rb * h + 600 * 7 * h, 0, -7 * h, 7 * h, 0] }];
  const rsw = Object.assign(new OEM.RFMT(), { REFERENCE_FRAME_type: OEM.RFMUnion.OrbitFrameWrapper,
    REFERENCE_FRAME: Object.assign(new OEM.OrbitFrameWrapperT(), { frame: OEM.OrbitFrame.RSW_INERTIAL }) });
  const radialTight = [1e-8, 0, 1e-2, 0, 0, 1e-2, 0, 0, 0, 1e-8, 0, 0, 0, 0, 1e-8, 0, 0, 0, 0, 0, 1e-8];
  const { report, records } = await associate([
    predictions([
      block({ norad: 101, objectId: 'A', states: still(7000), covariances: covs(diagonal(1e-8)) }),
      block({ norad: 102, objectId: 'B', states: bStates, covariances: covs(radialTight), covFrame: rsw }),
    ]),
    range('o1', 7000.0014, T0), range('o2', 6999.9995, T0), options({ light_time: false }),
  ]);
  const S = 1e-6 + 1e-8;
  const [o1, o2] = report.observations;
  const d2 = (o, key) => o.candidates.find((c) => c.object.key === key).d2;
  const close = (a, b, what) => assert.ok(Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(b)), `${what}: ${a} vs ${b}`);
  close(d2(o1, 'A'), 1.4e-3 ** 2 / S, 'o1-A');
  close(d2(o1, 'B'), 1.6e-3 ** 2 / S, 'o1-B');
  close(d2(o2, 'A'), 0.5e-3 ** 2 / S, 'o2-A');
  close(d2(o2, 'B'), 3.5e-3 ** 2 / S, 'o2-B');
  const gate = report.gate_thresholds['1'];
  const costs = { o1: { A: d2(o1, 'A'), B: d2(o1, 'B') }, o2: { A: d2(o2, 'A'), B: d2(o2, 'B') } };
  let best = null;
  for (const a1 of ['A', 'B', null]) for (const a2 of ['A', 'B', null]) {
    if (a1 && a1 === a2) continue;
    const c = (o, a) => (a && costs[o][a] <= gate ? costs[o][a] : a ? Infinity : gate);
    const total = c('o1', a1) + c('o2', a2);
    if (!best || total < best.total) best = { total, a1, a2 };
  }
  assert.deepEqual([o1.object?.key, o2.object?.key], [best.a1, best.a2]);
  assert.deepEqual([best.a1, best.a2], ['B', 'A']);
  assert.equal(o1.ambiguous, true, 'o1 lost its nearest object to the global assignment');
  assert.equal(o1.assignment_conflict, true);
  assert.equal(o2.ambiguous, false, "o2's second object is outside the gate");
  // Equal S: posterior = exp(-d2/2) normalised over the in-gate objects.
  const pB = Math.exp(-costs.o1.B / 2) / (Math.exp(-costs.o1.A / 2) + Math.exp(-costs.o1.B / 2));
  close(o1.posterior, pB, 'o1 posterior');
  const out = Object.fromEntries(records.associated.map(({ record }) => [record.ID, record]));
  assert.equal(out.o1.SAT_NO, 102);
  assert.equal(out.o1.ON_ORBIT, 'B');
  assert.equal(out.o1.UCT, false);
  assert.equal(out.o2.SAT_NO, 101);
  assert.equal(records.ucts.length, 0);
  // The statistics on the records (SDS 1.241.0) are the report's.
  close(out.o1.CORR_MAHALANOBIS_SQ, costs.o1.B, 'o1 CORR_MAHALANOBIS_SQ');
  close(out.o1.CORR_P_VALUE, o1.p_value, 'o1 CORR_P_VALUE');
  close(out.o1.CORR_QUALITY, pB, 'o1 CORR_QUALITY');
  assert.deepEqual([out.o1.CORR_DOF, out.o1.CORR_GATE, out.o1.CORR_AMBIGUOUS], [1, gate, true]);
  close(out.o2.CORR_MAHALANOBIS_SQ, costs.o2.A, 'o2 CORR_MAHALANOBIS_SQ');
  assert.equal(out.o2.CORR_AMBIGUOUS, false);
});

test('a radar DOPPLER of carrier DOPPLER_FREQUENCY is the two-way range rate -c df / (2 f)', async () => {
  // A GEO object seen from an Earth-fixed radar on the equator (range rate
  // needs the sensor's velocity). A range rate of 0.01 +- 0.05 km/s and the
  // X-band (10 GHz) two-way Doppler of the same rate, df = -2 f rdot / c
  // with sigma 2 f sigma_rdot / c, must give the same d2 (1e-9 relative:
  // they differ only by the conversion's rounding); a sign or factor error
  // would not. A DOPPLER without its carrier is refused.
  const C = 299792.458, f = 1e10, rate = 0.01, sigma = 0.05;
  const geo = [{ epoch: T0, state: [42164, 0, 0, 0, 3.07, 0] }, { epoch: T1, state: [42164, 1842, 0, 0, 3.07, 0] }];
  const prediction = predictions([block({ norad: 7, objectId: 'GEO', states: geo, covariances: covs(diagonal(1, 1e-6)) })]);
  const eop = earthOrientation([eopRow({ date: '2026-08-02', mjd: 61254, xArcsec: 0.2, yArcsec: 0.3, dut1: 0.05 })]);
  const base = { OB_TIME: T, ID_SENSOR: 'radar', SEN_REFERENCE_FRAME: 'ITRF', SENX: 6378.137, SENY: 0, SENZ: 0 };
  const { report, error } = await associate([prediction, eop, options({ light_time: false }),
    rdo({ ...base, ID: 'rate', RANGE_RATE: rate, RANGE_RATE_UNC: sigma }),
    rdo({ ...base, ID: 'doppler', DOPPLER: -2 * f * rate / C, DOPPLER_UNC: 2 * f * sigma / C, DOPPLER_FREQUENCY: f })]);
  assert.equal(error, undefined, error);
  const [byRate, byDoppler] = ['rate', 'doppler'].map((id) => report.observations.find((o) => o.id === id));
  const d2 = (o) => o.candidates[0].d2;
  assert.equal(byDoppler.source.range_rate_km_s, 'DOPPLER');
  assert.ok(d2(byRate) > 0, `d2 ${d2(byRate)}`);
  assert.ok(Math.abs(d2(byDoppler) - d2(byRate)) <= 1e-9 * d2(byRate), `${d2(byDoppler)} vs ${d2(byRate)}`);
  const refused = await associate([prediction, eop, rdo({ ...base, ID: 'bare', DOPPLER: 1, DOPPLER_UNC: 1 })]);
  assert.match(refused.error, /DOPPLER_FREQUENCY/);
});

test('an Earth-fixed sensor is rotated to GCRF as in Vallado\'s IAU-2006/2000 worked example', async () => {
  // Vallado, Fundamentals of Astrodynamics and Applications, 4th ed.,
  // section 3.7 worked example (IAU-2006/2000, CIO based): 2004-04-06 07:51:28.386009 UTC,
  // xp = -0.140682", yp = 0.333309", UT1-UTC = -0.4399619 s,
  // LOD = 0.0015563 s, dX = -0.000205", dY = -0.000136".
  // r_ITRF = (-1033.4793830, 7901.2952754, 6380.3565958) km gives
  // r_GCRF = (5102.508958, 6123.011401, 6378.136928) km. Tolerance 2 cm:
  // the module evaluates the series with SOFA's algorithms (ERFA), which
  // reproduce Vallado's printed vector to 1.1 cm (component differences
  // +1.5, -8.0 and +6.4 mm); a centimetre is far below any sensor position
  // uncertainty that matters to association.
  const epoch = '2004-04-06T07:51:28.386009Z';
  const state = [{ epoch: '2004-04-06T07:50:00Z', state: [42164, 0, 0, 0, 3.07, 0] }, { epoch: '2004-04-06T07:53:00Z', state: [42164, 552.6, 0, 0, 3.07, 0] }];
  const { report, error } = await associate([
    predictions([block({ norad: 1, objectId: 'GEO', states: state, covariances: [{ epoch: state[0].epoch, lower: diagonal(1) }, { epoch: state[1].epoch, lower: diagonal(1) }] })]),
    rdo({ ID: 'vallado', OB_TIME: epoch, ID_SENSOR: 'vallado-3-14', SEN_REFERENCE_FRAME: 'ITRF', SENX: -1033.4793830, SENY: 7901.2952754, SENZ: 6380.3565958, RANGE: 40000, RANGE_UNC: 1 }),
    earthOrientation([eopRow({ date: '2004-04-06', mjd: 53101, xArcsec: -0.140682, yArcsec: 0.333309, dut1: -0.4399619, lod: 0.0015563, dXArcsec: -0.000205, dYArcsec: -0.000136 })]),
  ]);
  assert.equal(error, undefined, error);
  const s = report.observations[0].sensor_gcrf_km;
  const expected = [5102.508958, 6123.011401, 6378.136928];
  for (let k = 0; k < 3; k++) assert.ok(Math.abs(s[k] - expected[k]) <= 2e-5, `component ${k}: ${s[k]} vs ${expected[k]}`);
});
