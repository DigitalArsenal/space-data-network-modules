import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { ASG, assignedOf, associate, block, celestial, diagonal, earthOrientation, eopRow, predictions, problemFrame, rdo, solveAssignment, OEM } from './lib.mjs';

const fixture = (name) => new URL(`./fixtures/${name}`, import.meta.url);
import { denseProblem, hungarianOptimum, sparseOptimum, sparseProblem } from './assignment-problems.mjs';

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
      range('o', 7000),
    ], { gate_probability: p, light_time: false });
    for (let dof = 1; dof <= 6; dof++) {
      const expected = nist.criticalValues[dof][k];
      const gate = report.GATE_THRESHOLDS.find((g) => g.DEGREES_OF_FREEDOM === dof).THRESHOLD;
      assert.ok(Math.abs(gate - expected) <= 5e-4, `P=${p}, dof ${dof}: ${gate} vs NIST ${expected}`);
    }
  }
});

test('seeded assignment problems of the OR-Library sizes solve to the optimum an independent Hungarian method finds', async () => {
  // Dense 100 x 100 and 200 x 200, and sparse 800 x 800 (absent pairs are
  // forbidden): tests/assignment-problems.mjs. Integer costs: the optimum is exact.
  for (const [name, n, seed] of [['dense100', 100, 100], ['dense200', 200, 200]]) {
    const cost = denseProblem(n, seed);
    const optimal = hungarianOptimum(cost);
    const solution = await solveAssignment({ cost });
    assert.equal(solution.TOTAL_COST, optimal, name);
    assert.equal(new Set(solution.ASSIGNMENT).size, n, `${name}: a permutation`);
    assert.equal(solution.ASSIGNMENT.reduce((s, j, i) => s + cost[i][j], 0), optimal, `${name}: the assignment costs what it reports`);
  }
  const problem = sparseProblem(800, 800);
  const solution = await solveAssignment(problem);
  assert.equal(solution.TOTAL_COST, sparseOptimum(problem));
  const permitted = new Map(problem.entries.map(([i, j, c]) => [`${i},${j}`, c]));
  assert.ok(solution.ASSIGNMENT.every((j, i) => permitted.has(`${i},${j}`)), 'only permitted pairs');
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
    range('o1', 7000.0014, T0), range('o2', 6999.9995, T0),
  ], { light_time: false });
  const S = 1e-6 + 1e-8;
  const [o1, o2] = report.OBSERVATIONS;
  const d2 = (o, key) => o.CANDIDATES.find((c) => c.OBJECT.KEY === key).D2;
  const close = (a, b, what) => assert.ok(Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(b)), `${what}: ${a} vs ${b}`);
  close(d2(o1, 'A'), 1.4e-3 ** 2 / S, 'o1-A');
  close(d2(o1, 'B'), 1.6e-3 ** 2 / S, 'o1-B');
  close(d2(o2, 'A'), 0.5e-3 ** 2 / S, 'o2-A');
  close(d2(o2, 'B'), 3.5e-3 ** 2 / S, 'o2-B');
  const gate = report.GATE_THRESHOLDS.find((g) => g.DEGREES_OF_FREEDOM === 1).THRESHOLD;
  const costs = { o1: { A: d2(o1, 'A'), B: d2(o1, 'B') }, o2: { A: d2(o2, 'A'), B: d2(o2, 'B') } };
  let best = null;
  for (const a1 of ['A', 'B', null]) for (const a2 of ['A', 'B', null]) {
    if (a1 && a1 === a2) continue;
    const c = (o, a) => (a && costs[o][a] <= gate ? costs[o][a] : a ? Infinity : gate);
    const total = c('o1', a1) + c('o2', a2);
    if (!best || total < best.total) best = { total, a1, a2 };
  }
  assert.deepEqual([assignedOf(o1)?.OBJECT.KEY, assignedOf(o2)?.OBJECT.KEY], [best.a1, best.a2]);
  assert.deepEqual([best.a1, best.a2], ['B', 'A']);
  assert.equal(o1.AMBIGUOUS, true, 'o1 lost its nearest object to the global assignment');
  assert.equal(o1.ASSIGNMENT_CONFLICT, true);
  assert.equal(o2.AMBIGUOUS, false, "o2's second object is outside the gate");
  // Equal S: posterior = exp(-d2/2) normalised over the in-gate objects.
  const pB = Math.exp(-costs.o1.B / 2) / (Math.exp(-costs.o1.A / 2) + Math.exp(-costs.o1.B / 2));
  close(assignedOf(o1).POSTERIOR, pB, 'o1 posterior');
  const out = Object.fromEntries(records.associated.map(({ record }) => [record.ID, record]));
  assert.equal(out.o1.SAT_NO, 102);
  assert.equal(out.o1.ON_ORBIT, 'B');
  assert.equal(out.o1.UCT, false);
  assert.equal(out.o2.SAT_NO, 101);
  assert.equal(records.ucts.length, 0);
  // The statistics on the records (SDS 1.241.0) are the report's.
  close(out.o1.CORR_MAHALANOBIS_SQ, costs.o1.B, 'o1 CORR_MAHALANOBIS_SQ');
  close(out.o1.CORR_P_VALUE, assignedOf(o1).P_VALUE, 'o1 CORR_P_VALUE');
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
  const { report, error } = await associate([prediction, eop,
    rdo({ ...base, ID: 'rate', RANGE_RATE: rate, RANGE_RATE_UNC: sigma }),
    rdo({ ...base, ID: 'doppler', DOPPLER: -2 * f * rate / C, DOPPLER_UNC: 2 * f * sigma / C, DOPPLER_FREQUENCY: f })], { light_time: false });
  assert.equal(error, undefined, error);
  const [byRate, byDoppler] = ['rate', 'doppler'].map((id) => report.OBSERVATIONS.find((o) => o.ID === id));
  const d2 = (o) => o.CANDIDATES[0].D2;
  assert.equal(byDoppler.MEASUREMENTS.find((m) => m.KIND === ASG.asgMeasurementKind.RangeRate).SOURCE_FIELD, 'DOPPLER');
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
  const s = report.OBSERVATIONS[0].SENSOR_POSITION_GCRF_KM;
  const expected = [5102.508958, 6123.011401, 6378.136928];
  for (let k = 0; k < 3; k++) assert.ok(Math.abs(s[k] - expected[k]) <= 2e-5, `component ${k}: ${s[k]} vs ${expected[k]}`);
});

test('the report gives an Earth-fixed sensor\'s GCRF velocity, the rate of its GCRF position', async () => {
  // The Vallado section 3.7 sensor and EOP above, observed at t - 1 s, t and
  // t + 1 s (UTC). Two references independent of the reported velocity:
  // 1. the central difference of the reported GCRF positions (the chain the
  //    test above checks against Vallado): agreement within 3e-8 km/s. The
  //    one $EOP row holds UT1 - UTC constant, so these positions turn at the
  //    nominal rate while the module advances UT1 at 1 - LOD/86400
  //    (1.8e-8 of 0.58 km/s, 1.1e-8 km/s); the difference's truncation
  //    error, omega^3 r h^2 / 6, is 4e-10 km/s. Turning the sensor about the
  //    ITRF z axis instead, which the polar motion tilts by 0.36" here,
  //    misses by 2.8e-7 km/s.
  // 2. the closed form |v| = omega (1 - LOD / 86400 s) sqrt(x^2 + y^2),
  //    omega = 7.292115146706979e-5 rad/s (IERS Conventions 2010), the
  //    distance from the ITRF z axis: within 1e-5 relative, the polar motion
  //    (0.36", 1.7e-6 rad) tilting the rotation axis; and v is orthogonal to
  //    r and to the axis to the same order.
  const sensor = [-1033.4793830, 7901.2952754, 6380.3565958];
  const times = ['2004-04-06T07:51:27.386009Z', '2004-04-06T07:51:28.386009Z', '2004-04-06T07:51:29.386009Z'];
  const state = [{ epoch: '2004-04-06T07:50:00Z', state: [42164, 0, 0, 0, 3.07, 0] }, { epoch: '2004-04-06T07:53:00Z', state: [42164, 552.6, 0, 0, 3.07, 0] }];
  const { report, error } = await associate([
    predictions([block({ norad: 1, objectId: 'GEO', states: state, covariances: [{ epoch: state[0].epoch, lower: diagonal(1) }, { epoch: state[1].epoch, lower: diagonal(1) }] })]),
    ...times.map((t, i) => rdo({ ID: `v${i}`, OB_TIME: t, ID_SENSOR: 'vallado-3-14', SEN_REFERENCE_FRAME: 'ITRF', SENX: sensor[0], SENY: sensor[1], SENZ: sensor[2], RANGE: 40000, RANGE_UNC: 1 })),
    earthOrientation([eopRow({ date: '2004-04-06', mjd: 53101, xArcsec: -0.140682, yArcsec: 0.333309, dut1: -0.4399619, lod: 0.0015563, dXArcsec: -0.000205, dYArcsec: -0.000136 })]),
  ]);
  assert.equal(error, undefined, error);
  const at = (i) => report.OBSERVATIONS.find((o) => o.ID === `v${i}`);
  const v = at(1).SENSOR_VELOCITY_GCRF_KM_S;
  const difference = [0, 1, 2].map((k) => (at(2).SENSOR_POSITION_GCRF_KM[k] - at(0).SENSOR_POSITION_GCRF_KM[k]) / 2);
  for (let k = 0; k < 3; k++) assert.ok(Math.abs(v[k] - difference[k]) <= 3e-8, `component ${k}: ${v[k]} vs ${difference[k]} km/s`);
  const speed = Math.hypot(...v);
  const closed = 7.292115146706979e-5 * (1 - 0.0015563 / 86400) * Math.hypot(sensor[0], sensor[1]);
  assert.ok(Math.abs(speed - closed) <= 1e-5 * closed, `|v| ${speed} vs ${closed} km/s`);
  const r = at(1).SENSOR_POSITION_GCRF_KM;
  assert.ok(Math.abs(v[0] * r[0] + v[1] * r[1] + v[2] * r[2]) <= 1e-5 * speed * Math.hypot(...r), 'v is orthogonal to r');
});

test('an inertial sensor reports no GCRF velocity', async () => {
  const state = [{ epoch: '2004-04-06T07:50:00Z', state: [42164, 0, 0, 0, 3.07, 0] }, { epoch: '2004-04-06T07:53:00Z', state: [42164, 552.6, 0, 0, 3.07, 0] }];
  const { report, error } = await associate([
    predictions([block({ norad: 1, objectId: 'GEO', states: state, covariances: [{ epoch: state[0].epoch, lower: diagonal(1) }, { epoch: state[1].epoch, lower: diagonal(1) }] })]),
    rdo({ ID: 'space', OB_TIME: '2004-04-06T07:51:28.386009Z', ID_SENSOR: 'space', SEN_REFERENCE_FRAME: 'GCRF', SENX: 7000, SENY: 0, SENZ: 0, RANGE: 35000, RANGE_UNC: 1 }),
  ]);
  assert.equal(error, undefined, error);
  assert.deepEqual(report.OBSERVATIONS[0].SENSOR_VELOCITY_GCRF_KM_S, [], 'no velocity');
});

test('the $ASG problem forms: a gated dense problem, a sparse one with repeats, a maximization, and refusals', async () => {
  // Rows 0 and 1, columns 0..2; null forbidden. Row 0 pays 1.5 to stay unassigned, row 1 pays 5.
  // Enumeration: r0 -> c0 (1) + r1 -> c1 (2) = 3 beats r0 unassigned (1.5) + r1 -> c0 (2) = 3.5 and r0 -> c2 (3) + r1 -> c0 (2) = 5.
  const gated = await solveAssignment({ cost: [[1, null, 3], [2, 2, null]], unassigned_cost: [1.5, 5] });
  assert.deepEqual([gated.ASSIGNMENT, gated.TOTAL_COST, gated.ASSIGNED, gated.ROWS, gated.COLUMNS], [[0, 1], 3, 2, 2, 3]);
  const leave = await solveAssignment({ cost: [[4, 9], [9, 9]], unassigned_cost: 0.5 });
  assert.deepEqual([leave.ASSIGNMENT, leave.TOTAL_COST, leave.ASSIGNED], [[-1, -1], 1, 0]);
  // A repeated sparse pair keeps its lowest cost.
  const sparse = await solveAssignment({ rows: 2, columns: 2, entries: [[0, 0, 5], [0, 0, 1], [1, 1, 2], [0, 1, 0.5], [1, 0, 0.5]] });
  assert.deepEqual([sparse.ASSIGNMENT, sparse.TOTAL_COST], [[1, 0], 1]);
  // Maximize: the largest total, reported in the problem's own sign.
  const max = await solveAssignment({ cost: [[4, 1, 3], [2, 0, 5]], objective: 'Maximize' });
  assert.deepEqual([max.ASSIGNMENT, max.TOTAL_COST], [[0, 2], 9]);
  assert.match((await solveAssignment({ cost: [[1, 2], [3, 4], [5, 6]] })).error, /more rows than columns/);
  assert.match((await solveAssignment({ cost: [[null, null], [1, 2]] })).error, /no feasible solution/);
  assert.match((await solveAssignment({ cost: [[1, 2]], unassigned_cost: [1, 2] })).error, /UNASSIGNED_COST/);
});

test('options come from the node config; a bad value is refused with its key', async () => {
  const inputs = [predictions([block({ norad: 1, objectId: 'A', states: still(7000), covariances: covs(diagonal(1e-8)) })]), range('o', 7000)];
  const { report } = await associate(inputs, { scan: 'observation', max_candidates: 2, geometry: false, light_time: false, min_posterior: 0.5, clutter_density: 0.25 });
  const o = report.OPTIONS;
  assert.deepEqual([o.SCAN, o.MAX_CANDIDATES, o.GEOMETRY, o.LIGHT_TIME, o.MIN_POSTERIOR, o.CLUTTER_DENSITY, o.GATE_PROBABILITY],
    [ASG.asgScanGrouping.Observation, 2, false, false, 0.5, 0.25, 0.9973]);
  assert.deepEqual(report.OBSERVATIONS[0].CANDIDATES[0].POSITION_GCRF_KM, [], 'geometry off');
  const defaults = (await associate(inputs)).report.OPTIONS;
  assert.deepEqual([defaults.SCAN, defaults.MAX_CANDIDATES, defaults.GEOMETRY, defaults.LIGHT_TIME], [ASG.asgScanGrouping.SensorTime, 5, true, true]);
  assert.match((await associate(inputs, { gate_probability: 1.5 })).error, /gate_probability/);
  assert.match((await associate(inputs, { scan: 'sideways' })).error, /scan/);
  assert.match((await associate(inputs, { max_candidates: 2.5 })).error, /max_candidates/);
  assert.match((await associate(inputs, { light_time: 'yes' })).error, /light_time/);
  assert.equal((await associate(inputs, { other_module_key: 1 })).error, undefined, 'keys of other modules are not refused');
});
