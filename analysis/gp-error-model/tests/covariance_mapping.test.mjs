import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createBrowserModuleHarness } from 'space-data-module-sdk/host/browser-module';

// common_epoch, map_covariance and screening_cases through the built artifact.
// Expected values do not come from this module: tests/stm-reference.json is
// written by tests/stm-reference.py from python-sgp4's pure-Python SGP4
// (WGS-72, opsmode i), pyerfa (GCRF -> TEME = Rz(ee06a) pnm06a at TT), a
// two-body propagator in the eccentric anomaly with Richardson-extrapolated
// central differences for its STM, and Newton shooting for the Lambert arc.
// Element sets: Vallado's SGP4-VER 06251, two variants, and a GPS-like set.
// Units: km, km/s; TEME for STMs, GCRF for common_epoch, RTN for covariances.
const root = process.env.SPACE_DATA_STANDARDS_ROOT ?? path.dirname(createRequire(import.meta.url).resolve('spacedatastandards.org/package.json'));
const require = createRequire(path.join(root, 'package.json'));
const flatbuffers = require('flatbuffers');
const load = async (code) => import(pathToFileURL(path.join(root, `lib/js/${code}/main.js`)));
const [OMM, OEM] = await Promise.all(['OMM', 'OEM'].map(load));
const wasm = fs.readFileSync(fileURLToPath(new URL('../dist/isomorphic/module.wasm', import.meta.url)));
const manifest = JSON.parse(fs.readFileSync(new URL('../plugin-manifest.json', import.meta.url)));
const ref = JSON.parse(fs.readFileSync(new URL('./stm-reference.json', import.meta.url)));

function omm(s) {
  const t = new OMM.OMMT();
  Object.assign(t, { EPOCH: s.EPOCH, NORAD_CAT_ID: s.norad, MEAN_ELEMENT_THEORY: OMM.meanElementSource.SGP4, MEAN_MOTION: s.MEAN_MOTION,
    ECCENTRICITY: s.ECCENTRICITY, INCLINATION: s.INCLINATION, RA_OF_ASC_NODE: s.RA_OF_ASC_NODE, ARG_OF_PERICENTER: s.ARG_OF_PERICENTER,
    MEAN_ANOMALY: s.MEAN_ANOMALY, BSTAR: s.BSTAR });
  const b = new flatbuffers.Builder(512);
  OMM.OMM.finishSizePrefixedOMMBuffer(b, t.pack(b));
  return Buffer.from(b.asUint8Array());
}
const elements = (...names) => ({ portId: 'elements', payload: Buffer.concat(names.map((n) => omm(ref.sets[n]))),
  typeRef: { schemaName: 'OMM.fbs', fileIdentifier: '$OMM', rootTypeName: 'OMM', wireFormat: 'flatbuffer' } });
function reference(norad, lines) {
  const block = new OEM.ephemerisDataBlockT();
  Object.assign(block, { CENTER_NAME: 'EARTH', TIME_SYSTEM: OEM.timingStandard.UTC, EPHEMERIS_DATA_LINES: lines.map(([epoch, x]) => {
    const l = new OEM.ephemerisDataLineT();
    l.EPOCH = `${epoch}Z`;
    [l.X, l.Y, l.Z, l.X_DOT, l.Y_DOT, l.Z_DOT] = x;
    return l;
  }) });
  block.OBJECT = Object.assign(new OEM.CATT(), { NORAD_CAT_ID: norad });
  block.REFERENCE_FRAME = Object.assign(new OEM.RFMT(), { NAME: 'GCRF' });
  const b = new flatbuffers.Builder(4096);
  OEM.OEM.finishSizePrefixedOEMBuffer(b, Object.assign(new OEM.OEMT(), { EPHEMERIS_DATA_BLOCK: [block] }).pack(b));
  return { portId: 'reference', payload: Buffer.from(b.asUint8Array()), typeRef: { schemaName: 'OEM.fbs', fileIdentifier: '$OEM', rootTypeName: 'OEM', wireFormat: 'flatbuffer' } };
}
const json = (portId, value) => ({ portId, payload: Buffer.from(JSON.stringify(value)), typeRef: { schemaName: 'application/json' } });
async function call(t, methodId, inputs) {
  const h = await createBrowserModuleHarness({ wasmSource: wasm, manifest, surface: 'direct' });
  t.after(() => h.destroy());
  const r = await h.invoke({ methodId, inputs });
  assert.equal(r.statusCode, 0, r.errorMessage);
  return JSON.parse(Buffer.from(r.outputs[0].payload).toString());
}
const frobenius = (a) => Math.sqrt(a.reduce((s, x) => s + x * x, 0));
const relative = (a, b) => frobenius(a.map((x, i) => x - b[i])) / frobenius(b);
const matvec = (m, x) => [0, 1, 2, 3, 4, 5].map((i) => m.slice(6 * i, 6 * i + 6).reduce((s, v, k) => s + v * x[k], 0));
// Each RTN difference: position within 2 mm, velocity within 2e-9 km/s (the
// two SGP4 implementations and frame transforms differ at the 1e-9 level).
function closeRtn(actual, expected, what) {
  for (let k = 0; k < 6; ++k) assert.ok(Math.abs(actual[k] - expected[k]) <= (k < 3 ? 2e-6 : 2e-9), `${what}[${k}]: ${actual[k]} vs ${expected[k]}`);
}

test('common_epoch: sets at one epoch against a reference state, their mean and one set', async (t) => {
  const ce = ref.commonEpoch;
  const sets = ce.sets.map((n) => ref.sets[n].EPOCH);
  const norad = 6251;
  const out = await call(t, 'common_epoch', [elements('leo', 'leo-b', 'leo-c'),
    reference(norad, [[ce.target, ce.reference], [ce.later, ce.referenceLater]]),
    json('options', { targets: [
      { norad, epoch: ce.target, sets, origin: 'reference' },
      { norad, epoch: ce.target, sets, origin: 'mean' },
      { norad, epoch: ce.target, sets, origin: 'set', originSet: ref.sets['leo-b'].EPOCH },
      // The first reference epoch within 60 s after a nominal epoch 5 s after the target.
      { norad, epoch: new Date(Date.parse(`${ce.target}Z`) + 5000).toISOString().replace('Z', ''), afterSeconds: 60, sets, origin: 'reference' },
      { norad, epoch: new Date(Date.parse(`${ce.later}Z`) + 1000).toISOString().replace('Z', ''), afterSeconds: 30, sets, origin: 'reference' },
    ] })]);
  assert.equal(out.kind, 'common-epoch');
  const [byRef, byMean, bySet, after, none] = out.targets;
  for (const [row, expected] of [[byRef, ce.expected.reference], [byMean, ce.expected.mean], [bySet, ce.expected.set], [after, ce.expected.afterSeconds]]) {
    assert.equal(row.sets.length, 3);
    row.sets.forEach((s, i) => {
      const name = ce.sets[i];
      assert.equal(s.epoch, ref.sets[name].EPOCH);
      closeRtn(s.rtn, expected[name], `${row.origin} ${name}`);
    });
  }
  byRef.sets.forEach((s, i) => assert.ok(Math.abs(s.ageDays - ce.ages[ce.sets[i]]) < 1e-9, 'age'));
  assert.ok(byRef.sets[1].ageDays < 0, 'a set after the target propagates backwards');
  closeRtn(byMean.state.slice(0, 3).concat(byMean.state.slice(3)), ce.expected.meanState, 'mean state (GCRF)');
  assert.equal(after.epoch, `${ce.later}Z`);
  assert.equal(none.missing, 'no reference state');
  assert.equal(out.counts.missingTargets, 1);
});

test('map_covariance sgp4: Phi = J(t) J(t0)^-1 against python-sgp4 central differences, and against propagated perturbations', async (t) => {
  for (const c of ref.sgp4) {
    const out = await call(t, 'map_covariance', [elements(c.set), json('options', { requests: [{ norad: ref.sets[c.set].norad,
      set: ref.sets[c.set].EPOCH, from: c.fromEpoch, covariance: c.covariance, to: c.targets.map((x) => x.epoch), method: 'sgp4', stm: true }] })]);
    const rows = out.results[0].targets;
    rows.forEach((row, k) => {
      const e = c.targets[k];
      assert.equal(row.error, undefined, row.error);
      // Two implementations of SGP4 differenced at 1e-7 steps: agreement to 1e-7 of the matrix.
      assert.ok(relative(row.stm, e.stm) < 1e-7, `${c.set} ${e.minutes} min STM: ${relative(row.stm, e.stm)}`);
      assert.ok(relative(row.covariance, e.covariance) < 1e-7, `${c.set} ${e.minutes} min covariance: ${relative(row.covariance, e.covariance)}`);
      // Finite-difference truth: SGP4 run from elements displaced so the state at t0 moves by dx0 (central,
      // so the remainder is third order): Phi dx0 within 1e-5 of it.
      const linear = matvec(row.stm, c.perturbationTeme);
      assert.ok(relative(linear, e.perturbation) < 1e-5, `${c.set} ${e.minutes} min perturbation: ${relative(linear, e.perturbation)}`);
    });
  }
});

test('map_covariance two-body: complex-step Kepler STM against finite differences of an eccentric-anomaly propagator; symplectic', async (t) => {
  for (const c of ref.twoBody) {
    const out = await call(t, 'map_covariance', [elements(c.set), json('options', { requests: [{ norad: ref.sets[c.set].norad,
      set: ref.sets[c.set].EPOCH, covariance: ref.sgp4[0].covariance, to: c.targets.map((x) => x.epoch), method: 'two-body', stm: true }] })]);
    out.results[0].targets.forEach((row, k) => {
      const e = c.targets[k];
      assert.ok(relative(row.stm, e.stm) < 1e-7, `${c.set} ${e.minutes} min: ${relative(row.stm, e.stm)}`);
      // Phi' J Phi = J for Hamiltonian flow (J = [[0, I], [-I, 0]]).
      const p = row.stm;
      let worst = 0;
      for (let i = 0; i < 6; ++i)
        for (let j = 0; j < 6; ++j) {
          let s = 0;
          for (let a = 0; a < 3; ++a) s += p[6 * a + i] * p[6 * (a + 3) + j] - p[6 * (a + 3) + i] * p[6 * a + j];
          const want = i < 3 && j === i + 3 ? 1 : i >= 3 && j === i - 3 ? -1 : 0;
          worst = Math.max(worst, Math.abs(s - want));
        }
      const scale = Math.max(...p.map(Math.abs)) ** 2;  // products of entries cancel to 0 or 1
      assert.ok(worst < 1e-14 * scale, `symplectic ${c.set} ${e.minutes} min: ${worst} (entries to ${Math.sqrt(scale)})`);
    });
  }
});

test('map_covariance lambert: the Thompson et al. (2019) arc through SGP4 positions, and its two-body STM', async (t) => {
  for (const c of ref.lambert) {
    const out = await call(t, 'map_covariance', [elements(c.set), json('options', { requests: [{ norad: ref.sets[c.set].norad,
      set: ref.sets[c.set].EPOCH, covariance: ref.sgp4[0].covariance, to: c.targets.map((x) => x.epoch), method: 'lambert', stm: true }] })]);
    out.results[0].targets.forEach((row, k) => {
      const e = c.targets[k];
      assert.equal(row.error, undefined, row.error);
      assert.equal(row.lambert.revolutions, e.revolutions, `${c.set} ${e.minutes} min revolutions`);
      const dv = Math.hypot(...row.lambert.v1.map((v, i) => v - e.v1[i]));
      assert.ok(dv < 1e-8, `${c.set} ${e.minutes} min v1 differs by ${dv} km/s`);
      assert.ok(relative(row.stm, e.stm) < 1e-6, `${c.set} ${e.minutes} min STM: ${relative(row.stm, e.stm)}`);
    });
  }
});

// sgp4 (J(t) J(t0)^-1) and lambert (one arc between the same two SGP4 positions)
// invert exactly; two-body starts each map from SGP4's own state, so its round
// trip runs along two different arcs and is not an identity (its backward map
// is checked against the reference above).
test('map_covariance: at t0 the covariance is returned unchanged; a target before t0 inverts the forward map', async (t) => {
  const c = ref.sgp4[1];
  const s = ref.sets[c.set];
  const back = c.targets.find((x) => x.minutes < c.fromMinutes);
  for (const method of ['sgp4', 'two-body', 'lambert']) {
    const out = await call(t, 'map_covariance', [elements(c.set), json('options', { requests: [{ norad: s.norad, set: s.EPOCH,
      from: c.fromEpoch, covariance: c.covariance, to: [c.fromEpoch, back.epoch], method }] })]);
    const [same, earlier] = out.results[0].targets;
    assert.ok(relative(same.covariance, c.covariance) < 1e-12, `${method} at t0`);
    // Map back, then forward from there to t0 again: the round trip restores the covariance.
    const round = await call(t, 'map_covariance', [elements(c.set), json('options', { requests: [{ norad: s.norad, set: s.EPOCH,
      from: back.epoch, covariance: earlier.covariance, to: [c.fromEpoch], method }] })]);
    const error = relative(round.results[0].targets[0].covariance, c.covariance);
    if (method === 'two-body') console.log(`two-body round trip (two arcs): relative change ${error.toExponential(2)}`);
    else assert.ok(error < 1e-6, `${method} round trip: ${error}`);
  }
});

test('map_covariance axesSet: the input covariance is read in another set\'s RTN axes at t0', async (t) => {
  // An RTN covariance in leo-b's axes at leo's epoch, mapped along leo's arc to
  // leo's own axes at t0 (zero time): the rotation between the two RTN frames,
  // from the reference states of tests/stm-reference.json (TEME, python-sgp4).
  const s = ref.sets.leo, b = ref.sets['leo-b'];
  const c0 = ref.sgp4[0].covariance;
  const out = await call(t, 'map_covariance', [elements('leo', 'leo-b'), json('options', { requests: [
    { norad: 6251, set: s.EPOCH, axesSet: b.EPOCH, covariance: c0, to: [s.EPOCH], method: 'sgp4' },
    { norad: 6251, set: s.EPOCH, covariance: c0, to: [s.EPOCH], method: 'sgp4' }] })]);
  const [rotated, same] = out.results.map((r) => r.targets[0].covariance);
  assert.equal(out.results[0].axesSet, b.EPOCH);
  assert.ok(relative(same, c0) < 1e-12);
  const rot = ref.axes.leoBToLeoAtLeoEpoch;  // 3x3, leo-b RTN -> leo RTN
  const B = Array.from({ length: 36 }, (_, k) => { const i = Math.floor(k / 6), j = k % 6; return (i < 3) === (j < 3) ? rot[(i % 3) * 3 + (j % 3)] : 0; });
  const full = Array(36).fill(0);
  for (let a = 0, q = 0; a < 6; ++a) for (let c = 0; c <= a; ++c, ++q) full[6 * a + c] = full[6 * c + a] = c0[q];
  const mul = (x, y) => Array.from({ length: 36 }, (_, k) => { const i = Math.floor(k / 6), j = k % 6; let v = 0; for (let m = 0; m < 6; ++m) v += x[6 * i + m] * y[6 * m + j]; return v; });
  const tr = (x) => Array.from({ length: 36 }, (_, k) => x[6 * (k % 6) + Math.floor(k / 6)]);
  const want = mul(mul(B, full), tr(B));
  const lower = [];
  for (let a = 0; a < 6; ++a) for (let c = 0; c <= a; ++c) lower.push(want[6 * a + c]);
  assert.ok(relative(rotated, lower) < 1e-9, `rotated: ${relative(rotated, lower)}`);
  assert.ok(relative(rotated, c0) > 1e-4, 'the two sets\' axes differ');
});

test('map_covariance lambert over 88 revolutions (LAGEOS-like, synthetic elements): the arc STM is symplectic and the map back inverts', async (t) => {
  // A two-week map back along many revolutions: Thompson et al.'s energy rule
  // can pick a nearly radial branch; whatever the arc, its two-body STM must be
  // symplectic and mapping back then forward must restore the covariance.
  const s = { norad: 99002, EPOCH: '2026-04-11T08:43:36.786144', MEAN_MOTION: 6.38665, ECCENTRICITY: 0.0045, INCLINATION: 109.8,
    RA_OF_ASC_NODE: 156.5, ARG_OF_PERICENTER: 316.6, MEAN_ANOMALY: 35.8, BSTAR: 0 };
  const b = new flatbuffers.Builder(512);
  const o = new OMM.OMMT();
  Object.assign(o, { EPOCH: s.EPOCH, NORAD_CAT_ID: s.norad, MEAN_ELEMENT_THEORY: OMM.meanElementSource.SGP4, MEAN_MOTION: s.MEAN_MOTION,
    ECCENTRICITY: s.ECCENTRICITY, INCLINATION: s.INCLINATION, RA_OF_ASC_NODE: s.RA_OF_ASC_NODE, ARG_OF_PERICENTER: s.ARG_OF_PERICENTER,
    MEAN_ANOMALY: s.MEAN_ANOMALY, BSTAR: s.BSTAR });
  OMM.OMM.finishSizePrefixedOMMBuffer(b, o.pack(b));
  const el = { portId: 'elements', payload: Buffer.from(b.asUint8Array()), typeRef: { schemaName: 'OMM.fbs', fileIdentifier: '$OMM', rootTypeName: 'OMM', wireFormat: 'flatbuffer' } };
  const later = '2026-04-25T07:16:07.682880';
  const c0 = ref.sgp4[0].covariance;
  const back = await call(t, 'map_covariance', [el, json('options', { requests: [{ norad: 99002, set: s.EPOCH, from: later, covariance: c0, to: [s.EPOCH], method: 'lambert', stm: true }] })]);
  const row = back.results[0].targets[0];
  assert.equal(row.error, undefined, row.error);
  assert.ok(row.lambert.revolutions >= 80, `revolutions ${row.lambert.revolutions}`);
  const p = row.stm;
  let worst = 0;
  for (let i = 0; i < 6; ++i) for (let j = 0; j < 6; ++j) {
    let v = 0;
    for (let a = 0; a < 3; ++a) v += p[6 * a + i] * p[6 * (a + 3) + j] - p[6 * (a + 3) + i] * p[6 * a + j];
    const want = i < 3 && j === i + 3 ? 1 : i >= 3 && j === i - 3 ? -1 : 0;
    worst = Math.max(worst, Math.abs(v - want));
  }
  const scale = Math.max(...p.map(Math.abs)) ** 2;
  assert.ok(worst < 1e-14 * scale, `symplectic: ${worst} (entries to ${Math.sqrt(scale)})`);
  // Mapping back and forward again restores the covariance to the precision
  // the map's conditioning allows: entries near 1e6 s give a condition number
  // near 1e12-1e13, so double precision keeps about 1e-3 of a round trip.
  const round = await call(t, 'map_covariance', [el, json('options', { requests: [{ norad: 99002, set: s.EPOCH, covariance: row.covariance, to: [later], method: 'lambert' }] })]);
  const error = relative(round.results[0].targets[0].covariance, c0);
  assert.ok(error < 1e-2, `round trip ${error}`);
  console.log(`88-revolution round trip: relative change ${error.toExponential(2)}, STM entries to ${Math.sqrt(scale).toExponential(2)}`);
});

test('screening_cases: Foster Pc in closed form for zero miss, and a polar-grid integral for an offset anisotropic pair', async (t) => {
  const s = 0.01, R = 0.02;  // km: 10 m per axis, 20 m hard body
  const iso = [s * s, 0, s * s, 0, 0, s * s];
  const out = await call(t, 'screening_cases', [json('cases', { pairs: [{ e1: [0, 0, 0], c1: iso, e2: [0, 0, 0], c2: iso }] }),
    json('options', { hardBodyRadiusM: 20, missDistancesM: [0], directions: 4 })]);
  // Relative covariance 2 s^2 I in either plane: Pc = 1 - exp(-R^2 / (4 s^2)).
  for (const g of ['head-on', 'crossing-90']) assert.ok(Math.abs(out.summary[g][0].meanPc - (1 - Math.exp(-(R * R) / (4 * s * s)))) < 1e-9, g);
  // Offset errors and correlated covariances; Pc by a 600 x 1440 polar grid over the disk.
  const c1 = [4e-4, 1e-4, 9e-4, 0, 2e-4, 2.5e-4], c2 = [1e-4, 0, 2e-4, 0, 0, 3e-4];
  const e1 = [0.004, -0.01, 0.006], e2 = [-0.008, 0.02, 0.003];
  const two = await call(t, 'screening_cases', [json('cases', { pairs: [{ e1, c1, e2, c2 }] }),
    json('options', { hardBodyRadiusM: 20, missDistancesM: [0, 30], directions: 4 })]);
  const h = Math.SQRT1_2;
  const geometries = { 'head-on': [[[1, 0, 0], [0, 0, 1]], [[1, 0, 0], [0, 0, -1]]], 'crossing-90': [[[1, 0, 0], [0, h, h]], [[1, 0, 0], [0, h, -h]]] };
  const full = (l) => [[l[0], l[1], l[3]], [l[1], l[2], l[4]], [l[3], l[4], l[5]]];
  const proj = (c, a) => a.map((u) => a.map((w) => u.reduce((x, ui, i) => x + ui * w.reduce((y, wj, j) => y + wj * c[i][j], 0), 0)));
  for (const [g, [a1, a2]] of Object.entries(geometries)) {
    const p1 = proj(full(c1), a1), p2 = proj(full(c2), a2);
    const C = [[p1[0][0] + p2[0][0], p1[0][1] + p2[0][1]], [p1[1][0] + p2[1][0], p1[1][1] + p2[1][1]]];
    const det = C[0][0] * C[1][1] - C[0][1] * C[1][0];
    const i00 = C[1][1] / det, i01 = -C[0][1] / det, i11 = C[0][0] / det;
    const pe = (e, a) => a.map((u) => u[0] * e[0] + u[1] * e[1] + u[2] * e[2]);
    const d1 = pe(e1, a1), d2 = pe(e2, a2);
    [0, 30].forEach((m, mi) => {
      let mean = 0;
      for (let d = 0; d < 4; ++d) {
        const phi = (d + 0.5) * Math.PI / 2;
        const px = m * 1e-3 * Math.cos(phi) + d2[0] - d1[0], py = m * 1e-3 * Math.sin(phi) + d2[1] - d1[1];
        let sum = 0;
        for (let a = 0; a < 600; ++a) {
          const rho = (a + 0.5) * R / 600;
          for (let b = 0; b < 1440; ++b) {
            const th = (b + 0.5) * 2 * Math.PI / 1440, dx = rho * Math.cos(th) - px, dy = rho * Math.sin(th) - py;
            sum += rho * (R / 600) * (2 * Math.PI / 1440) * Math.exp(-0.5 * (i00 * dx * dx + 2 * i01 * dx * dy + i11 * dy * dy));
          }
        }
        mean += sum / (2 * Math.PI * Math.sqrt(det)) / 4;
      }
      const got = two.summary[g][mi].meanPc;
      assert.ok(Math.abs(got - mean) <= 1e-4 * mean, `${g} ${m} m: ${got} vs ${mean}`);
    });
  }
  const h2 = await createBrowserModuleHarness({ wasmSource: wasm, manifest, surface: 'direct' });
  t.after(() => h2.destroy());
  const bad = await h2.invoke({ methodId: 'screening_cases', inputs: [json('cases', { pairs: [{ e1, c1: [1, 2, 1, 0, 0, 1], e2, c2 }] })] });
  assert.notEqual(bad.statusCode, 0, 'a covariance that is not positive definite is refused');
});
